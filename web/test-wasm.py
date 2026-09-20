#!/usr/bin/env python3
"""Headless startup smoke test for the packaged Qt WebAssembly application."""

import argparse
import http.server
import pathlib
import re
import threading

from playwright.sync_api import sync_playwright


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dist", nargs="?", default="build-wasm/dist")
    args = parser.parse_args()
    dist = pathlib.Path(args.dist).resolve()
    required = ("index.html", "ArchMaths.js", "ArchMaths.wasm", "qtloader.js")
    missing = [name for name in required if not (dist / name).is_file()]
    if missing:
        raise SystemExit("missing WASM files: " + ", ".join(missing))

    handler = lambda *a, **kw: QuietHandler(*a, directory=str(dist), **kw)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors = []
    browser = None
    page = None
    console_log = []
    try:
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(
                    headless=True,
                    args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
                )
                page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
                page.add_init_script("""
                    Object.defineProperty(navigator, 'platform', {value: 'OHOS'});
                    window.__wasmWebGL2 = false;
                    window.__wasmPlotDraws = 0;
                    const getContext = HTMLCanvasElement.prototype.getContext;
                    HTMLCanvasElement.prototype.getContext = function(type, attrs) {
                        const context = getContext.call(this, type, attrs);
                        if (type === 'webgl2' && context) window.__wasmWebGL2 = true;
                        return context;
                    };
                    const drawArrays = WebGL2RenderingContext.prototype.drawArrays;
                    WebGL2RenderingContext.prototype.drawArrays = function(mode, first, count) {
                        if (mode === this.LINE_STRIP && count > 1) window.__wasmPlotDraws++;
                        return drawArrays.call(this, mode, first, count);
                    };
                """)
                page.on("pageerror", lambda error: errors.append("pageerror: " + str(error)))

                def on_console(message):
                    text = message.text
                    console_log.append(f"{message.type}: {text}")
                    if message.type == "error":
                        errors.append("console.error: " + text)
                    if re.search(
                        r"QOpenGLShader(?:::|Program::)(?:compile|link|uniformLocation)|"
                        r"shader.*(?:failed|not linked|unsupported)|WebGL.*INVALID_",
                        text,
                        re.IGNORECASE,
                    ):
                        errors.append("console shader: " + text)

                page.on("console", on_console)
                page.goto(f"http://127.0.0.1:{server.server_port}/index.html", wait_until="domcontentloaded")
                page.locator("#loading").wait_for(state="hidden", timeout=30_000)
                page.locator("canvas").first.wait_for(state="visible", timeout=10_000)
                if not page.evaluate("window.__wasmWebGL2"):
                    raise RuntimeError("application did not create a WebGL2 context")

                plot_draws = page.evaluate("window.__wasmPlotDraws")
                page.mouse.click(30, 40)
                page.wait_for_timeout(300)
                page.mouse.click(120, 105)
                if not page.evaluate("""() =>
                    document.getElementById('screen').shadowRoot.activeElement?.tagName === 'INPUT'
                """):
                    raise RuntimeError("click did not focus the HarmonyOS text input")
                page.keyboard.type("y=")
                page.keyboard.insert_text("sin")
                page.keyboard.type("(x)")
                page.mouse.click(550, 350)
                page.wait_for_function("before => window.__wasmPlotDraws > before", arg=plot_draws)
                page.wait_for_timeout(500)
                if errors:
                    raise RuntimeError("; ".join(errors))
            except Exception as error:
                pathlib.Path("wasm-smoke-failure.log").write_text(
                    "\n".join(console_log + errors + ["TEST FAILURE: " + str(error)]),
                    encoding="utf-8",
                )
                if page is not None:
                    page.screenshot(path="wasm-smoke-failure.png", full_page=True)
                raise
            finally:
                if browser is not None:
                    browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()

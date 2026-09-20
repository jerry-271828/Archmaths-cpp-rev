# WebAssembly

默认构建组合是 **Qt 6.5.3（wasm_singlethread）+ Emscripten 3.1.25**，与发布 CI 一致。
还需要同版本的桌面 Qt，为交叉编译提供 moc、rcc 和 uic。

Linux 下安装 Qt：

```bash
python3 -m pip install aqtinstall
aqt install-qt linux desktop 6.5.3 gcc_64 -O "$HOME/Qt"
aqt install-qt linux desktop 6.5.3 wasm_singlethread -O "$HOME/Qt"
```

安装并激活 Emscripten 3.1.25 后，在仓库根目录构建：

```bash
EMSDK_PATH="$HOME/emsdk" \
QT_WASM_PATH="$HOME/Qt/6.5.3/wasm_singlethread" \
QT_HOST_PATH="$HOME/Qt/6.5.3/gcc_64" \
bash build-wasm.sh
```

脚本使用 Qt 的 `qt-cmake` 配置工具链，输出可部署目录 `build-wasm/dist/`。
该目录必须包含 `index.html`、`ArchMaths.js`、`ArchMaths.wasm` 和与 Qt 版本匹配的 `qtloader.js`。

## 中文字体与键盘输入

Qt 6.5 的 wasm 平台只能从编译进二进制的 `:/fonts/` 资源同步加载字体；其
Local Font Access 异步路径在字体注册后不会刷新 fallback 缓存，中文会一直显示为方框。
因此 `build-wasm.sh` 在构建后调用 `web/patch-wasm-font.py`，把
`web/fonts/DejaVuSans-subset.ttf`（HarmonyOS Sans SC + Noto Sans Symbols 2 的合并子集，
覆盖源码全部字符与约 2500 个 GB2312 一级汉字）写进 wasm 里 DejaVuSans.ttf 的存储槽位。
要重新生成该字体（需要本机系统字体），运行：

```bash
python3 web/fonts/gen-subset-font.py
```

`web/shell.html` 在 shadow root 的捕获阶段监听 pointerdown，把浏览器焦点保持在
Qt 窗口内。鸿蒙浏览器通过原生文本输入节点接收输入法提交的文字，再转交给 Qt。
这样可以处理字母、符号按下时仅产生 `Process / 229` 事件的情况；普通按键、退格和
快捷键仍交由 Qt 处理，输入法组词在提交时写入一次。

启动本地服务器：

```bash
python3 -m http.server --directory build-wasm/dist 8000
```

打开 <http://localhost:8000>。页面需要通过 HTTP/HTTPS 加载，并且浏览器需要支持 WebGL 2。
当前单线程构建可使用普通静态服务器；多线程 Qt 构建还需要 COOP/COEP 响应头。
Qt 版本与 Emscripten 版本应匹配，详见 [Qt WebAssembly 文档](https://doc.qt.io/qt-6/wasm.html)。

浏览器检查与发布 CI 使用同一脚本：

```bash
python3 -m pip install playwright
python3 -m playwright install --with-deps chromium
python3 web/test-wasm.py build-wasm/dist
```

检查会加载实际 WASM，确认 Qt 画布和 WebGL 2 上下文已创建，并捕获启动和着色器错误。
键盘检查模拟鸿蒙平台，混合普通按键与输入法文本提交来输入表达式并验证绘图。

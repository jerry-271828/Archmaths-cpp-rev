#include <QApplication>
#ifdef WASM_BUILD
#include <QSurfaceFormat>
#endif
#include "ui/MainWindow.h"

int main(int argc, char* argv[]) {
#ifdef WASM_BUILD
    // The browser shaders use GLSL ES 3.00 and require a WebGL 2 context.
    QSurfaceFormat format;
    format.setRenderableType(QSurfaceFormat::OpenGLES);
    format.setVersion(3, 0);
    QSurfaceFormat::setDefaultFormat(format);
#endif
    QApplication app(argc, argv);

    // 设置应用程序信息
    QApplication::setApplicationName("Arch Maths");
    QApplication::setApplicationVersion("1.0.0");
    QApplication::setOrganizationName("ArchMaths");

    // 设置高DPI支持
    QApplication::setAttribute(Qt::AA_UseHighDpiPixmaps);

    // 创建并显示主窗口
    ArchMaths::MainWindow mainWindow;
    mainWindow.show();

    return app.exec();
}

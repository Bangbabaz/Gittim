# Windows 安装脚本：设置 CL=/utf-8 解决 MSVC 对 whisper.cpp UTF-8 源文件编码识别问题
$env:CL = "/utf-8"
yarn install

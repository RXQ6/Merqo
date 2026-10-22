@echo off
set "CRAFT_CONFIG_DIR=%~dp0.runtime\config"
set "RETAILPILOT_USER_DATA_DIR=%~dp0.runtime\chromium"
set "ELECTRON_RUN_AS_NODE="
set "RETAILPILOT_SMOKE="
set "RETAILPILOT_VERIFY_VISIBLE="
start "" /D "%~dp0" "%~dp0artifacts\windows\0.1.0-beta.9\win-unpacked\Merqo.exe"

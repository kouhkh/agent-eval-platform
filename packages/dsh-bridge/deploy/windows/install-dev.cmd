@echo off
setlocal

set "DSH_ROOT=%~1"
if not defined DSH_ROOT set "DSH_ROOT=%~dp0..\..\..\deepseek-harness"
for %%I in ("%DSH_ROOT%") do set "DSH_ROOT=%%~fI"

if not exist "%DSH_ROOT%\package.json" (
  echo DSH root does not contain package.json: %DSH_ROOT% 1>&2
  exit /b 2
)

for /f "usebackq delims=" %%R in ("%~dp0..\..\..\DSH_REVISION.txt") do set "DSH_CLIENT_COMMIT_HASH=%%R"
if not defined DSH_CLIENT_COMMIT_HASH (
  echo DSH revision is missing. 1>&2
  exit /b 3
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(!((major===22&&minor>=19)||major>=24)){console.error('Node 22.19+ or 24+ is required; found '+process.version);process.exit(1)}" || exit /b 4
corepack pnpm@11.7.0 --dir "%DSH_ROOT%" install --frozen-lockfile || exit /b 5
corepack pnpm@11.7.0 --dir "%DSH_ROOT%" run build:lib:host || exit /b 6
node "%DSH_ROOT%\apps\cli\lib\bin.js" --version || exit /b 7

echo DSH headless build is ready at %DSH_ROOT%

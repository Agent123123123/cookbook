# Build Code - OSS On Linux x64

This document records the steps that worked for building the Linux desktop package from this repository on an older Linux host.

Scope:
- Repository: `microsoft/vscode`
- Branch used during validation: `ai-ide-1.113.0`
- Target artifact: `VSCode-linux-x64`
- Validated on: older RHEL-like Linux host

## 1. Prerequisites

Required tools:

- Node.js `22.22.1`
- npm `10.x`
- Python `3.11+`
- `curl`, `tar`, `unzip`, `gzip`

Useful checks:

```bash
cat .nvmrc
node --version
npm --version
/usr/bin/python3.11 --version
```

At the time of validation, `.nvmrc` was:

```text
22.22.1
```

## 2. Why A Plain `npm ci` Fails On Older Linux Hosts

On this host, a plain `npm ci` failed for multiple independent reasons:

1. npm was configured to use a stale proxy.
2. Direct GitHub access was unreliable, but `build/linux/debian/install-sysroot.ts` uses Node `fetch`, not `curl`.
3. system `python3` was `3.6.8`, which is too old for the current `node-gyp` stack.
4. system `g++` was `8.5.0`, which is too old for modules that require `-std=gnu++20`.
5. `build/azure-pipelines/linux/setup-env.sh` needs a few JS helper modules before the full install finishes.
6. a partially populated `.build/sysroots` cache can make later native linking fail with missing `crti.o`, `crtbeginS.o`, `libc`, or `libm`.
7. a partially populated `.build/builtInExtensions/ms-vscode.js-debug` cache can make `bundle-marketplace-extensions-build` fail with:

```text
The following tasks did not complete: vscode-linux-x64-min
Did you forget to signal async completion?
```

## 3. Proxy Setup

If the machine needs a proxy, configure npm and also export proxy variables for Node `fetch`.

User-level npm config:

```bash
npm config set --location=user proxy http://HOST:PORT
npm config set --location=user https-proxy http://HOST:PORT
```

Validated runtime environment used during the successful build:

```bash
export HTTP_PROXY=http://192.168.31.27:10808
export HTTPS_PROXY=http://192.168.31.27:10808
export http_proxy=http://192.168.31.27:10808
export https_proxy=http://192.168.31.27:10808
export NODE_USE_ENV_PROXY=1
```

Important:

- `NODE_USE_ENV_PROXY=1` is required. Without it, Node `fetch` may hang after logging `Found asset ...` while downloading GitHub-hosted sysroot artifacts.

## 4. Bootstrap Dependencies For `setup-env.sh`

`build/azure-pipelines/linux/setup-env.sh` invokes `build/linux/libcxx-fetcher.ts`, which needs these modules before the full `npm ci` is complete.

Install them first without scripts:

```bash
cd /path/to/vscode

npm install --ignore-scripts debug extract-zip @electron/get --no-save
```

## 5. Clean Broken Sysroot Caches If Needed

If you previously interrupted the bootstrap, remove stale sysroot directories before retrying.

```bash
rm -rf .build/sysroots/glibc-2.28-gcc-10.5.0 \
       .build/sysroots/glibc-2.28-gcc-8.5.0
```

This is necessary when the directory exists but is incomplete, which later causes linker errors such as:

```text
ld.lld: error: cannot open crti.o: No such file or directory
ld.lld: error: cannot open crtbeginS.o: No such file or directory
ld.lld: error: unable to find library -lc
ld.lld: error: unable to find library -lm
```

## 6. Validated `npm ci` Sequence

The following sequence worked on this host:

```bash
cd /path/to/vscode

export HTTP_PROXY=http://192.168.31.27:10808
export HTTPS_PROXY=http://192.168.31.27:10808
export http_proxy=http://192.168.31.27:10808
export https_proxy=http://192.168.31.27:10808
export NODE_USE_ENV_PROXY=1
export VSCODE_ARCH=x64
export npm_config_arch=x64
export PYTHON=/usr/bin/python3.11
export npm_config_python=/usr/bin/python3.11

npm install --ignore-scripts debug extract-zip @electron/get --no-save

rm -rf .build/sysroots/glibc-2.28-gcc-10.5.0 \
       .build/sysroots/glibc-2.28-gcc-8.5.0

python() { /usr/bin/python3.11 "$@"; }
export -f python
source ./build/azure-pipelines/linux/setup-env.sh

SYSROOT="$VSCODE_CLIENT_SYSROOT_DIR/x86_64-linux-gnu/x86_64-linux-gnu/sysroot"
export PKG_CONFIG_SYSROOT_DIR="$SYSROOT"
export PKG_CONFIG_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$SYSROOT/usr/lib/pkgconfig:$SYSROOT/usr/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"

rm -rf node_modules
npm ci
```

## 7. Built-In Marketplace Extensions Cache Workaround

On this branch, `vscode-linux-x64-min` can fail early in `bundle-marketplace-extensions-build` if the local cache under `.build/builtInExtensions` is partial.

The problematic symptom was:

```text
The following tasks did not complete: vscode-linux-x64-min
Did you forget to signal async completion?
```

In the validated run, `.build/builtInExtensions/ms-vscode.js-debug` existed but was incomplete and had no `package.json`.

### Quick check

```bash
node - <<'NODE'
const fs = require('fs');
for (const name of [
  'ms-vscode.js-debug-companion',
  'ms-vscode.js-debug',
  'ms-vscode.vscode-js-profile-table'
]) {
  const p = `.build/builtInExtensions/${name}/package.json`;
  console.log(name, fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).version : 'MISSING');
}
NODE
```

### Repair `ms-vscode.js-debug` cache if it is partial

```bash
rm -rf .build/builtInExtensions/ms-vscode.js-debug
mkdir -p .build/builtInExtensions/ms-vscode.js-debug

gzfile=$(mktemp /tmp/js-debug-XXXXXX.gz)
vsixfile=$(mktemp /tmp/js-debug-XXXXXX.vsix)
rm -f "$vsixfile"

curl -L -o "$gzfile" \
  -H 'X-Market-Client-Id: VSCode Build' \
  -H 'User-Agent: VSCode Build' \
  -H 'X-Market-User-Id: 291C1CD0-051A-4123-9B4B-30D60EF52EE2' \
  'https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-vscode/vsextensions/js-debug/1.112.0/vspackage'

gzip -dc "$gzfile" > "$vsixfile"
mkdir -p /tmp/js-debug-extract
rm -rf /tmp/js-debug-extract/*
unzip -q "$vsixfile" 'extension/*' -d /tmp/js-debug-extract
cp -a /tmp/js-debug-extract/extension/. .build/builtInExtensions/ms-vscode.js-debug/
rm -rf /tmp/js-debug-extract "$gzfile" "$vsixfile"
```

After that, the Linux min build was able to reuse all three cached marketplace extensions.

## 8. Validated Linux Desktop Build Command

The following command succeeded:

```bash
cd /path/to/vscode

export HTTP_PROXY=http://192.168.31.27:10808
export HTTPS_PROXY=http://192.168.31.27:10808
export http_proxy=http://192.168.31.27:10808
export https_proxy=http://192.168.31.27:10808
export NODE_USE_ENV_PROXY=1
export VSCODE_ARCH=x64
export npm_config_arch=x64
export PYTHON=/usr/bin/python3.11
export npm_config_python=/usr/bin/python3.11
export SKIP_TSGO_TYPECHECK=1

python() { /usr/bin/python3.11 "$@"; }
export -f python
source ./build/azure-pipelines/linux/setup-env.sh

SYSROOT="$VSCODE_CLIENT_SYSROOT_DIR/x86_64-linux-gnu/x86_64-linux-gnu/sysroot"
export PKG_CONFIG_SYSROOT_DIR="$SYSROOT"
export PKG_CONFIG_PATH="$SYSROOT/usr/lib/x86_64-linux-gnu/pkgconfig:$SYSROOT/usr/lib/pkgconfig:$SYSROOT/usr/share/pkgconfig"
export PKG_CONFIG_LIBDIR="$PKG_CONFIG_PATH"

npm run gulp -- vscode-linux-x64-min
```

## 9. Output Artifact

Validated output directory:

```text
/home/zick/prj/VSCode-linux-x64
```

Validated executable entry points:

```text
/home/zick/prj/VSCode-linux-x64/bin/code-oss
/home/zick/prj/VSCode-linux-x64/code-oss
```

## 10. Summary Of Host-Specific Rules

On this host, keep these rules:

1. Always use `/usr/bin/python3.11` for `node-gyp`.
2. Always export proxy variables and `NODE_USE_ENV_PROXY=1` before any step that downloads via Node `fetch`.
3. Always source `build/azure-pipelines/linux/setup-env.sh` before desktop Linux builds.
4. If native linking starts failing with missing crt or libc objects, delete `.build/sysroots/*` and regenerate them.
5. If `vscode-linux-x64-min` reports incomplete async completion around marketplace extensions, verify `.build/builtInExtensions/ms-vscode.js-debug/package.json` exists.
"""向 cap 生成的 android 工程注入固定签名配置（幂等）。
用法: python3 patch_signing.py <run_number>  （在 android/ 目录生成后、gradle 构建前执行）"""
import re, sys, os

run = sys.argv[1] if len(sys.argv) > 1 else "1"
base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(base, "android", "app", "build.gradle")
gradle = open(path, encoding="utf-8").read()

# 1) 版本号：versionCode = run 号（单调递增，支持覆盖安装）
gradle = re.sub(r"versionCode\s+\d+", f"versionCode {run}", gradle)
gradle = re.sub(r'versionName\s+"[^"]*"', f'versionName "0.3.{run}"', gradle)

# 2) 签名配置（幂等：已打过补丁则跳过注入）
if "auRelease" not in gradle:
    block = """
// === AU signing (auto-patched, do not edit) ===
def auKeystoreProps = new Properties()
def auPropsFile = rootProject.file("keystore.properties")
if (auPropsFile.exists()) {
    auKeystoreProps.load(new FileInputStream(auPropsFile))
}
signingConfigs {
    auRelease {
        storeFile file(auKeystoreProps['storeFile'])
        storePassword auKeystoreProps['storePassword']
        keyAlias auKeystoreProps['keyAlias']
        keyPassword auKeystoreProps['keyPassword']
        storeType auKeystoreProps['storeType']
    }
}
"""
    gradle = gradle.replace("buildTypes {", block + "\n    buildTypes {", 1)

# release 块绑定固定签名
gradle = gradle.replace("signingConfig signingConfigs.debug", "signingConfig signingConfigs.auRelease")
if "signingConfig signingConfigs.auRelease" not in gradle.split("buildTypes {", 1)[1]:
    gradle = re.sub(r"(release\s*\{)", r"\1\n            signingConfig signingConfigs.auRelease", gradle, count=1)

open(path, "w", encoding="utf-8").write(gradle)
print(f"patch_signing OK: versionCode={run}, versionName=0.3.{run}, signing=auRelease")

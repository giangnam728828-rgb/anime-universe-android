# Anime Universe Android

综合动漫/漫画/资讯/Android APP

## 项目概览

- **技术栈**：React + TypeScript + Vite + Capacitor
- **平台**：Android (APK)
- **构建方式**：GitHub Actions 云端构建

## 本地开发

```bash
npm install
npm run dev
```

## 构建 APK

GitHub Actions 自动构建：

- Push 到 `main` 分支 → 自动生成 APK
- 构建产物在 **Actions Artifacts** 中下载

## 目录结构

```
src/
├── App.tsx           ← 5底部导航主布局
├── main.tsx          ← 入口
├── index.css         ← 主题变量（暗色科技风）
└── types/            ← Anime/Manga/News 接口

.github/workflows/
└── build-apk.yml     ← 构建流程
```

## 许可证

MIT

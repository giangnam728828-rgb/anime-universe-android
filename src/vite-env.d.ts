/// <reference types="vite/client" />

// Vite 的 import.meta.env 类型声明（供 import.meta.env.DEV 使用）。
// 项目此前无环境判断，本文件为 defaultWarn 的生产静默判断（设计 §4.8 / 风险 R21）补充。
// 仅引用 Vite 官方类型，不引入其他环境变量体系。

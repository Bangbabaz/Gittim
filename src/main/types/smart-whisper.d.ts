// smart-whisper 没有发布官方 TS 类型;在 main bundle 里 dynamic import,实际
// 形状由 `stt.ts` 自己的 `WhisperInstance` 类型给出。这里只声明模块存在,让
// `await import('smart-whisper')` 能通过 typecheck —— 用户 `yarn install` 后包
// 自带 types(若有)会自动 merge / 覆盖此声明。
declare module 'smart-whisper'

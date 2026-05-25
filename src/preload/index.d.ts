import { ElectronAPI } from '@electron-toolkit/preload'
import type { Api } from './index'

// 共享类型集中在 @shared/types,index.ts 里完全用那一套生成 api。这里只需要
// `typeof api` 就能拿到完整签名 —— 旧版本里每个方法的 Promise<…> 都手写一遍,
// 改一个签名要同步改两处,极易漂移。
declare global {
  interface Window {
    electron: ElectronAPI
    api: Api
  }
}

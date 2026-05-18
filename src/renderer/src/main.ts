import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/style/index.scss'
// ElMessage / ElMessageBox are called imperatively, so unplugin-vue-components'
// on-demand style injection (which only sees template components) never picks
// up their CSS. Import it explicitly or every confirm box renders unstyled.
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'

import { createApp } from 'vue'
import App from './App.vue'

// Default to the historical dark look before useTheme() resolves the saved
// preference in App.onMounted — avoids a light flash for dark users.
document.documentElement.dataset.theme = 'dark'
document.documentElement.classList.add('dark')

createApp(App).mount('#app')

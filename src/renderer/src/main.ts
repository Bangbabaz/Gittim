import 'element-plus/theme-chalk/dark/css-vars.css'
import './assets/main.css'
import 'element-plus/es/components/message/style/css'

import { createApp } from 'vue'
import App from './App.vue'

document.documentElement.classList.add('dark')

createApp(App).mount('#app')

import { createApp } from 'vue';
import { createPinia } from 'pinia';
// 字体自托管：CSP 为 default-src 'self'，远端 @import 在生产环境会被完全拦截（docs/09 §7），线上将始终使用系统字体。
// 只引入 latin 子集与实际用到的字重（400 正文、600 标签按钮、700 标题与 <b>）；中文字形本就回退到系统字体，Fira 不含 CJK。
import '@fontsource/fira-sans/latin-400.css';
import '@fontsource/fira-sans/latin-600.css';
import '@fontsource/fira-sans/latin-700.css';
import '@fontsource-variable/fira-code/wght.css';
import 'primeicons/primeicons.css';
import './styles.css';
import App from './App.vue';
import { router } from './router';

createApp(App).use(createPinia()).use(router).mount('#app');

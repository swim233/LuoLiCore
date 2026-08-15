import { createApp } from 'vue';
import { createPinia } from 'pinia';
// 字体自托管：CSP 是 default-src 'self'，远端 @import 在生产会被整条挡掉（docs/09 §7），线上就一直是系统字体。
// 只引 latin 子集与真正用到的字重（400 正文 / 600 标签按钮 / 700 标题与 <b>）——中文字形本来就走系统回退，Fira 没有 CJK。
import '@fontsource/fira-sans/latin-400.css';
import '@fontsource/fira-sans/latin-600.css';
import '@fontsource/fira-sans/latin-700.css';
import '@fontsource-variable/fira-code/wght.css';
import 'primeicons/primeicons.css';
import './styles.css';
import App from './App.vue';
import { router } from './router';

createApp(App).use(createPinia()).use(router).mount('#app');

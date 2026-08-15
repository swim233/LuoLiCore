import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Aura from '@primeuix/themes/aura';
import 'primeicons/primeicons.css';
import './styles.css';
import App from './App.vue';
import { router } from './router';

// 界面全中文，PrimeVue 内建的英文空态串（"No available options"）会突兀地漏出来。
const locale = { emptyMessage: '没有可选项', emptySearchMessage: '没有匹配结果', emptySelectionMessage: '未选择', emptyFilterMessage: '没有匹配结果',
  aria: { moveUp: '上移', moveTop: '移到最前', moveDown: '下移', moveBottom: '移到最后', moveToTarget: '移入', moveAllToTarget: '全部移入', moveToSource: '移出', moveAllToSource: '全部移出', close: '关闭' } };
createApp(App).use(createPinia()).use(router).use(PrimeVue, { locale, theme: { preset: Aura, options: { darkModeSelector: '.dark' } } }).use(ToastService).mount('#app');

import { createApp } from 'vue';
import App from './App.vue';

import './style.css';

// PrimeVue
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';

// PrimeVue CSS
import 'primeicons/primeicons.css';
import 'primeflex/primeflex.css';

// Apply dark mode class BEFORE PrimeVue initialization
document.documentElement.classList.add('my-app-dark');

const app = createApp(App);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      prefix: 'p',
      darkModeSelector: '.my-app-dark',
      cssLayer: false,
    },
  },
});

app.mount('#app');



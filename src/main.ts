import { registerSW } from 'virtual:pwa-register';
import { App } from './app';
import './ui/styles.css';

registerSW({ immediate: true });

new App(document.getElementById('app')!);

import {defineConfig} from 'wxt';
import vue from '@vitejs/plugin-vue';
import {resolve} from 'path';
import fs from 'fs';


const packageJson = JSON.parse(fs.readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));


// See https://wxt.dev/api/config.html
export default defineConfig({
    modules: ['@wxt-dev/webextension-polyfill'],
    imports: {
        addons: {
            vueTemplate: true,
        },
    },
    vite: () => ({
        plugins: [vue()],
        define: {
            'process.env.VUE_APP_VERSION': JSON.stringify(packageJson.version),
        }
    }),
    zip: {
        // package.json 的 name 是中文，默认模板会生成 "-0.0.28-chrome.zip" 这样的文件名
        artifactTemplate: 'fluent-read-{{version}}-{{browser}}.zip',
        sourcesTemplate: 'fluent-read-{{version}}-sources.zip',
    },
    manifest: {
        permissions: ['storage', 'contextMenus', 'offscreen'],
    },

});
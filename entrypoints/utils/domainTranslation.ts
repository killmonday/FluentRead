import { config } from './config';
import { getMainDomain } from '../main/compat';
import { autoTranslateEnglishPage, restoreOriginalContent } from '../main/trans';

// 使用 sessionStorage 来存储域名翻译状态，这样会在浏览器关闭时自动清除
const DOMAIN_TRANSLATION_STATE_KEY = 'fluentread-domain-translation-states';

/**
 * 更新当前域名的翻译状态
 * @param isTranslated 当前页面是否已翻译
 */
export function updateDomainTranslationState(isTranslated: boolean): void {
    const currentDomain = getMainDomain(window.location.hostname);
    
    // 从 sessionStorage 获取当前的域名翻译状态
    let domainStates: { [domain: string]: boolean } = {};
    const storedStates = sessionStorage.getItem(DOMAIN_TRANSLATION_STATE_KEY);
    if (storedStates) {
        try {
            domainStates = JSON.parse(storedStates);
        } catch (e) {
            console.error('Failed to parse domain translation states:', e);
        }
    }
    
    // 更新当前域名的状态
    domainStates[currentDomain] = isTranslated;
    
    // 保存回 sessionStorage
    sessionStorage.setItem(DOMAIN_TRANSLATION_STATE_KEY, JSON.stringify(domainStates));
}

/**
 * 获取当前域名的翻译状态
 * @returns 如果当前域名需要自动翻译则返回true，否则返回false
 */
export function getCurrentDomainTranslationState(): boolean {
    const currentDomain = getMainDomain(window.location.hostname);
    
    // 从 sessionStorage 获取域名翻译状态
    const storedStates = sessionStorage.getItem(DOMAIN_TRANSLATION_STATE_KEY);
    if (storedStates) {
        try {
            const domainStates = JSON.parse(storedStates);
            return domainStates[currentDomain] || false;
        } catch (e) {
            console.error('Failed to parse domain translation states:', e);
            return false;
        }
    }
    
    return false;
}

/**
 * 检查是否应该在当前页面自动翻译
 * @returns 如果应该自动翻译则返回true，否则返回false
 */
export function shouldAutoTranslateOnCurrentPage(): boolean {
    // 检查全局翻译开关是否开启
    if (!config.on) {
        return false;
    }
    
    // 检查当前域名是否需要自动翻译
    return getCurrentDomainTranslationState();
}

/**
 * 在页面加载时检查是否需要自动翻译
 */
export function checkAndApplyDomainTranslation(): void {
    if (shouldAutoTranslateOnCurrentPage()) {
        // 延迟执行，确保页面内容已加载
        setTimeout(() => {
            autoTranslateEnglishPage();
        }, 1000);
    }
}

/**
 * 页面导航时更新当前域名
 */
export function updateCurrentDomain(): void {
    // 由于现在使用 sessionStorage 存储域名状态，不需要在 config 中维护当前域名
    // 此函数现在只是空函数，保留以兼容现有代码
}
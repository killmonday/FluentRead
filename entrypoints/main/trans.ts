import { checkConfig, searchClassName, skipNode } from "../utils/check";
import { cache } from "../utils/cache";
import { options, servicesType, services } from "../utils/option";
import { insertFailedTip, insertLoadingSpinner } from "../utils/icon";
import { styles } from "@/entrypoints/utils/constant";
import { beautyHTML, grabNode, grabAllNode, LLMStandardHTML, smashTruncationStyle, sanitizeHTML, checkTextSize, isMainlyNumericContent, shouldSkipNode, findTranslatableParent, skipSet, inlineSet } from "@/entrypoints/main/dom";
import { detectlang, throttle } from "@/entrypoints/utils/common";
import { getMainDomain, replaceCompatFn, selectCompatFn } from "@/entrypoints/main/compat";
import { config } from "@/entrypoints/utils/config";
import { translateText, cancelAllTranslations } from '@/entrypoints/utils/translateApi';
import { updateDomainTranslationState } from "@/entrypoints/utils/domainTranslation";

let hoverTimer: any; // 鼠标悬停计时器
let htmlSet = new Set(); // 防抖
export let originalContents = new Map(); // 保存原始内容
let isAutoTranslating = false; // 控制是否继续翻译新内容
let observer: IntersectionObserver | null = null; // 保存观察器实例
let mutationObserver: MutationObserver | null = null; // 保存 DOM 变化观察器实例

// 使用自定义属性标记已翻译的节点
const TRANSLATED_ATTR = 'data-fr-translated';
const TRANSLATED_ID_ATTR = 'data-fr-node-id'; // 添加节点ID属性

let nodeIdCounter = 0; // 节点ID计数器

// 正常链路中已入队的 Text 节点，用于复位 isAutoTranslating 后避免重复翻译
let normalTranslatedTextNodes = new WeakSet<Text>();

// ===== 暴力全文翻译（Brute-force full page translation）状态 =====

const BRUTE_MAX_CHUNK = 3000; // 单次翻译的最大字符数
const BRUTE_DEBOUNCE_MS = 400; // 动态内容防抖

// 暴力模式下仍然跳过的标签（代码、媒体、表单、内联框架单独遍历）
const BRUTE_SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option',
    'code', 'pre', 'kbd', 'samp', 'var', 'svg', 'math', 'canvas', 'video', 'audio', 'img',
    'object', 'embed', 'track', 'source', 'param', 'iframe'
]);

// 插件自身的 UI 与翻译产物，不能被暴力模式再次处理
const BRUTE_EXTENSION_SELECTOR = [
    '#fluent-read-floating-ball-container',
    '#fluent-read-translation-status-container',
    '#fluent-read-selection-translator-container',
    '#fluent-new-api-container',
    '.fluent-read-bilingual-content',
    '.fluent-read-loading',
    '.fluent-read-retry-wrapper',
    '.fluent-read-failure',
].join(',');

let bruteForceActive = false;
let bruteForceGeneration = 0; // 恢复后使在途响应失效
let bruteQueuedCount = 0; // 本次暴力翻译入队的单元数
let bruteObservers: MutationObserver[] = [];
let bruteObservedTargets = new WeakSet<Node>();
let brutePending = new Set<Node>();
let bruteDebounceTimer: any = null;
let bruteRoots = new Set<Document | ShadowRoot>(); // 主文档、shadow root、同源 iframe 文档
let bruteIframeDocs = new WeakSet<Document>();
let bruteIframeCleanups: Array<() => void> = [];
let bruteMarkedElements = new Set<Element>(); // document.querySelectorAll 看不到 shadow/iframe
let bruteMarkedIds = new Set<string>();
let bruteProcessedTextNodes = new WeakSet<Text>();
let bruteProcessedElements = new WeakSet<Element>();

// 恢复原文内容
export function restoreOriginalContent() {
    // 取消所有等待中的翻译任务
    cancelAllTranslations();

    // 停止暴力翻译观察器（原始 DOM 由 restoreBruteForceNodes 负责恢复）
    stopBruteForce();

    // 1. 遍历所有已翻译的节点（暴力翻译标记的节点交给 restoreBruteForceNodes 原样恢复）
    document.querySelectorAll(`[${TRANSLATED_ATTR}="true"]`).forEach(node => {
        const nodeId = node.getAttribute(TRANSLATED_ID_ATTR);
        if (nodeId && bruteMarkedIds.has(nodeId)) return;
        if (nodeId && originalContents.has(nodeId)) {
            const originalContent = originalContents.get(nodeId);
            // 安全清理原始HTML，防止XSS攻击
            const sanitizedContent = sanitizeHTML(originalContent);
            node.innerHTML = sanitizedContent;
            node.removeAttribute(TRANSLATED_ATTR);
            node.removeAttribute(TRANSLATED_ID_ATTR);

            // 移除可能添加的翻译相关类
            node.classList.remove('fluent-read-bilingual');
        }
    });

    // 2. 移除所有翻译内容元素
    document.querySelectorAll('.fluent-read-bilingual-content').forEach(element => {
        element.remove();
    });

    // 3. 移除所有翻译过程中添加的加载动画和错误提示
    document.querySelectorAll('.fluent-read-loading, .fluent-read-retry-wrapper').forEach(element => {
        element.remove();
    });

    // 4. 恢复 Shadow DOM / 同源 iframe 中的暴力翻译内容
    restoreBruteForceNodes();

    // 5. 清空存储的原始内容
    originalContents.clear();

    // 6. 停止所有观察器
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }

    // 7. 重置所有翻译相关的状态
    isAutoTranslating = false;
    htmlSet.clear(); // 清空防抖集合
    nodeIdCounter = 0; // 重置节点ID计数器
    normalTranslatedTextNodes = new WeakSet();

    // 8. 消除可能存在的全局样式污染
    const tempStyleElements = document.querySelectorAll('style[data-fr-temp-style]');
    tempStyleElements.forEach(el => el.remove());

    // 更新域名翻译状态为未翻译
    updateDomainTranslationState(false);
}

// 自动翻译整个页面的功能
export function autoTranslateEnglishPage() {
    // 如果已经在翻译中，则返回
    if (isAutoTranslating) return;
    
    // 如果是 Chrome 内置AI翻译，使用专用逻辑
    // if (config.service === services.chromeTranslator) {
    if (true) {
        chromeTranslatorTranslatePage();
        return;
    }
    
    // 获取当前页面的语言（暂时注释，存在识别问题）
    // const text = document.documentElement.innerText || '';
    // const cleanText = text.replace(/[\s\u3000]+/g, ' ').trim().slice(0, 500);
    // const language = detectlang(cleanText);
    // console.log('当前页面语言：', language);
    // const to = config.to;
    // if (to.includes(language)) {
    //     console.log('目标语言与当前页面语言相同，不进行翻译');
    //     return;
    // }
    // console.log('当前页面非目标语言，开始翻译');

    // 获取所有需要翻译的节点
    const nodes = grabAllNode(document.body);
    if (!nodes.length) return;

    isAutoTranslating = true;
    
    // 更新域名翻译状态为已翻译
    updateDomainTranslationState(true);

    // 创建观察器
    observer = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && isAutoTranslating) {
                const node = entry.target as Element;

                // 去重
                if (node.hasAttribute(TRANSLATED_ATTR)) return;
                
                // 为节点分配唯一ID
                const nodeId = `fr-node-${nodeIdCounter++}`;
                node.setAttribute(TRANSLATED_ID_ATTR, nodeId);
                
                // 保存原始内容
                originalContents.set(nodeId, node.innerHTML);
                
                // 标记为已翻译
                node.setAttribute(TRANSLATED_ATTR, 'true');

                if (config.display === styles.bilingualTranslation) {
                    // 双语对照模式
                    // console.log(" 双语对照模式", node );
                    handleBilingualTranslation(node, false);
                } else {
                    // 仅译文模式
                    handleSingleTranslation(node, false);
                }

                // 停止观察该节点
                observer.unobserve(node);
            }
        });
    }, {
        root: null,
        rootMargin: '50px',
        threshold: 0.1 // 只要出现10%就开始翻译
    });

    // 开始观察所有节点
    nodes.forEach(node => {
        observer?.observe(node);
    });

    // 创建 MutationObserver 监听 DOM 变化
    const mo = new MutationObserver((mutations) => {
        if (!isAutoTranslating) return;

        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) { // 元素节点
                    // 只处理未翻译的新节点
                    const newNodes = grabAllNode(node as Element).filter(
                        n => !n.hasAttribute(TRANSLATED_ATTR)
                    );
                    newNodes.forEach(n => observer?.observe(n));
                }
            });
        });
    });
    mutationObserver = mo;

    // 监听整个 body 的变化
    mo.observe(document.body, {
        childList: true,
        subtree: true
    });
}

// 处理鼠标悬停翻译的主函数
export function handleMousePointTranslation(mouseX: number, mouseY: number, delayTime: number = 0) {
    // 检查配置
    if (!checkConfig()) return;

    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {

        let node = grabNode(document.elementFromPoint(mouseX, mouseY));

        // 判断是否跳过节点
        if (skipNode(node)) return;

        // 防抖
        let nodeOuterHTML = node.outerHTML;
        if (htmlSet.has(nodeOuterHTML)) return;
        htmlSet.add(nodeOuterHTML);

        // 根据翻译模式进行翻译
        if (config.display === styles.bilingualTranslation) {
            handleBilingualTranslation(node, delayTime > 0);  // 根据 delayTime 可判断是否为滑动翻译
        } else {
            handleSingleTranslation(node, delayTime > 0);
        }
    }, delayTime);
}

// 双语翻译
export function handleBilingualTranslation(node: any, slide: boolean) {
    let nodeOuterHTML = node.outerHTML;
    // 如果已经翻译过，250ms 后删除翻译结果
    let bilingualNode = searchClassName(node, 'fluent-read-bilingual');
    if (bilingualNode) {
        if (slide) {
            htmlSet.delete(nodeOuterHTML);
            return;
        }
        let spinner = insertLoadingSpinner(bilingualNode as HTMLElement, true);
        setTimeout(() => {
            spinner.remove();
            const content = searchClassName(bilingualNode as HTMLElement, 'fluent-read-bilingual-content');
            if (content && content instanceof HTMLElement) content.remove();
            (bilingualNode as HTMLElement).classList.remove('fluent-read-bilingual');
            htmlSet.delete(nodeOuterHTML);
        }, 250);
        return;
    }

    // 检查是否有缓存
    let cached = cache.localGet(node.textContent);
    if (cached) {
        let spinner = insertLoadingSpinner(node, true);
        setTimeout(() => {
            spinner.remove();
            htmlSet.delete(nodeOuterHTML);
            bilingualAppendChild(node, cached);
        }, 250);
        return;
    }

    // 翻译
    bilingualTranslate(node, nodeOuterHTML);
}

// 仅译文翻译
export function handleSingleTranslation(node: any, slide: boolean) {
    let nodeOuterHTML = node.outerHTML;
    let outerHTMLCache = cache.localGet(node.outerHTML);


    if (outerHTMLCache) {
        // handleTranslation 已处理防抖 故删除判断 原bug 在保存完成后 刷新页面 可以取得缓存 直接return并没有翻译
        let spinner = insertLoadingSpinner(node, true);
        setTimeout(() => {
            spinner.remove();
            htmlSet.delete(nodeOuterHTML);

            // 安全清理缓存的HTML，防止XSS攻击
            const sanitizedCache = sanitizeHTML(outerHTMLCache);
            
            // 兼容部分网站独特的 DOM 结构
            let fn = replaceCompatFn[getMainDomain(document.location.hostname)];
            if (fn) fn(node, sanitizedCache);
            else node.outerHTML = sanitizedCache;

        }, 250);
        return;
    }

    singleTranslate(node);
}

// 执行双语翻译
function bilingualTranslate(node: any, nodeOuterHTML: any) {
    if (detectlang(node.textContent.replace(/[\s\u3000]/g, '')) === config.to) return;

    let origin = node.textContent;
    let spinner = insertLoadingSpinner(node);
    
    // 使用队列管理的翻译API
    translateText(origin, document.title)
        .then((text: string) => {
            spinner.remove();
            htmlSet.delete(nodeOuterHTML);
            bilingualAppendChild(node, text);
        })
        .catch((error: Error) => {
            spinner.remove();
            insertFailedTip(node, error.toString() || "翻译失败", spinner);
        });
}

// 进行仅译文模式下的翻译
export function singleTranslate(node: any) {
    if (!node.textContent.trim().replace(/[\s\u3000]/g, '')) return;
    if (detectlang(node.textContent.replace(/[\s\u3000]/g, '')) === config.to) return;
    let origin = "";
    // let origin = servicesType.isMachine(config.service) ? node.innerHTML : LLMStandardHTML(node);
    
    // own: 如果origin是<a>且有可见文本，则仅仅提取可见文本进行翻译，再把译文替换到原来的位置
    // console.log(node.tagName.toLowerCase());
    // if (node.tagName.toLowerCase() === 'a') {
    //     // 获取a标签里的可见文本
    //     let visibleText = node.textContent.trim().replace(/[\s\u3000]/g, '');
    //     if (!visibleText) return;
    //     origin = visibleText;
    // }else{
    //     origin = servicesType.isMachine(config.service) ? node.innerHTML : LLMStandardHTML(node);
    // }

    if (config.service === services.chromeTranslator) {
        origin = node.textContent.trim().replace(/[\s\u3000]/g, '');
    }else{
        origin = servicesType.isMachine(config.service) ? node.innerHTML : LLMStandardHTML(node);
    }

    
    let spinner = insertLoadingSpinner(node);
    

    // 使用队列管理的翻译API
    translateText(origin, document.title)
        .then((text: string) => {
            spinner.remove();
            if (config.service === services.chromeTranslator){

            }else{
                text = beautyHTML(text);
                if (!text || origin === text) return;
            }
            

            let oldOuterHtml = node.outerHTML;
            node.textContent = text;
            let newOuterHtml = node.outerHTML;
            
            // 缓存翻译结果
            cache.localSetDual(oldOuterHtml, newOuterHtml);
            cache.set(htmlSet, newOuterHtml, 250);
            htmlSet.delete(oldOuterHtml);
        })
        .catch((error: Error) => {
            spinner.remove();
            if (node.tagName.toLowerCase() !== 'a'){
                insertFailedTip(node, error.toString() || "翻译失败", spinner);
            }
        });
}

export const handleBtnTranslation = throttle((node: any) => {
    let origin = node.innerText;
    let rs = cache.localGet(origin);
    if (rs) {
        node.innerText = rs;
        return;
    }

    config.count++ && storage.setItem('local:config', JSON.stringify(config));

    browser.runtime.sendMessage({ context: document.title, origin: origin })
        .then((text: string) => {
            cache.localSetDual(origin, text);
            node.innerText = text;
        }).catch((error: any) => console.error('调用失败:', error))
}, 250)


function bilingualAppendChild(node: any, text: string) {
    node.classList.add("fluent-read-bilingual");
    let newNode = document.createElement("span");
    newNode.classList.add("fluent-read-bilingual-content");
    // find the style
    const style = options.styles.find(s => s.value === config.style && !s.disabled);
    if (style?.class) {
        newNode.classList.add(style.class);
    }
    newNode.append(text);
    smashTruncationStyle(node);
    node.appendChild(newNode);
}

// Chrome 内置AI翻译专用逻辑 提取文本而非html
function chromeTranslatorTranslatePage() {
    if (isAutoTranslating) return;
    isAutoTranslating = true;
    updateDomainTranslationState(true);

    try {
        chromeTranslatorScanPage();
    } finally {
        // 扫描是同步的，复位后再次触发全文翻译时才不会被永久锁死
        isAutoTranslating = false;
    }
}

function chromeTranslatorScanPage() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const translatedNodes = new Set();

    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        if (!textNode.textContent || !textNode.textContent.trim()) continue;
        // console.log(textNode.textContent);

        // 跳过已翻译的文本节点
        if (translatedNodes.has(textNode)) continue;
        // 跳过之前扫描中已入队的文本节点（避免复位后重复翻译）
        if (normalTranslatedTextNodes.has(textNode)) continue;
        // 没有父节点的跳过
        if (!textNode.parentElement) continue
        
        let currentFatherNode = textNode.parentElement

        // 已被暴力全文翻译标记的区域，避免正常链路重复翻译并覆盖原文记录
        const bruteMarked = currentFatherNode.closest(`[${TRANSLATED_ATTR}="true"]`);
        if (bruteMarked && bruteMarkedIds.has(bruteMarked.getAttribute(TRANSLATED_ID_ATTR) || '')) continue;

        // 检查父元素是否应该跳过
        if (currentFatherNode.classList?.contains('notranslate') || currentFatherNode.isContentEditable || skipSet.has(currentFatherNode.tagName?.toLowerCase()??'')){
            // console.log('[父节点属性skip]:', textNode.textContent);
            continue;
        } 
        // if (currentFatherNode.hasAttribute(TRANSLATED_ATTR)) {
        //     // console.log('[已翻译skip]:', textNode.textContent);
        //     continue
        // };

        // 获取当前节点的文本内容
        const textContent = textNode.textContent.trim();
        if (!textContent) continue;

        if (textContent.length < 4) continue;
        
        // 检查目标语言是否与当前文本语言相同
        if (detectlang(textContent) === config.to) {
            // console.log('[same lang skip]:', textNode.textContent);
            continue
        };

        //检查当前文本节点是否满足限制的长度和需要翻译，例如从组成几乎都是数字可以不翻译
        if (checkTextSize(textNode) || isMainlyNumericContent(textNode)) continue;

        // 找到允许翻译的父节点，获取后使用原先的逻辑来判断某些特殊网站（自定义的适配网站如youtube）里的一些元素是否需要翻译
        var selfNodeOrCanTranslated = findTranslatableParent(textNode);
        if (!selfNodeOrCanTranslated) { // 如果找不到允许翻译的父节点
            selfNodeOrCanTranslated = textNode
        }else{
            const fatherOfCanTran = selfNodeOrCanTranslated.parentElement
            const tagOfFatherCanTran = fatherOfCanTran?.tagName?.toLowerCase() ?? null
            if (fatherOfCanTran && (fatherOfCanTran.classList?.contains('notranslate') || fatherOfCanTran.isContentEditable)){
                continue;
            }
            if(tagOfFatherCanTran && skipSet.has(tagOfFatherCanTran)){
                continue;
            }
        }

        // 特殊适配一些站点：根据域名进行特殊处理
        var elementNode = (selfNodeOrCanTranslated.nodeType === Node.TEXT_NODE) ? textNode.parentElement : selfNodeOrCanTranslated
        const domainHandler = selectCompatFn[getMainDomain(location.href.split('?')[0])];
        if (domainHandler) {
            // console.log('击中特殊适配，elementNode:', elementNode);
            try{
                const result = domainHandler(elementNode);
                // 如果返回的是对象且包含skip属性为true，则跳过该节点
                if (result && typeof result === 'object' && 'skip' in result && result.skip === true) {
                    // console.log('[特殊适配skip]:', textNode.textContent);
                    continue
                }
            }catch(error){
            }
        }

        // 标记为已翻译
        translatedNodes.add(textNode);
        normalTranslatedTextNodes.add(textNode);
        const nodeId = `fr-node-${nodeIdCounter++}`;
        currentFatherNode.setAttribute(TRANSLATED_ID_ATTR, nodeId);
        
        // 保存原始内容 - 对于TextNode，我们需要保存父元素的innerHTML
        originalContents.set(nodeId, currentFatherNode.innerHTML);
        currentFatherNode.setAttribute(TRANSLATED_ATTR, 'true');

        
        // 根据显示模式进行翻译
        if (config.display === styles.bilingualTranslation) {
            // 双语模式
            const spinner = insertLoadingSpinner(currentFatherNode);
            translateText(textContent, document.title)
                .then((translatedText: string) => {
                    spinner.remove();
                    bilingualAppendChild(currentFatherNode, translatedText);
                })
                .catch((error: Error) => {
                    spinner.remove();
                    normalTranslatedTextNodes.delete(textNode);
                    // console.log('[translate error]:', textNode.textContent, error.toString() || "翻译失败");
                    insertFailedTip(currentFatherNode, error.toString() || "翻译失败", spinner);
                });
        } else {
            // 仅译文模式
            const spinner = insertLoadingSpinner(currentFatherNode);
            translateText(textContent, document.title)
                .then((translatedText: string) => {
                    spinner.remove();
                    // 直接替换TextNode的文本内容
                    textNode.textContent = translatedText;
                })
                .catch((error: Error) => {
                    spinner.remove();
                    normalTranslatedTextNodes.delete(textNode);
                    if (currentFatherNode.tagName.toLowerCase() !== 'a' && currentFatherNode.tagName.toLowerCase() !== 'span' && textNode.textContent.trim().length > 9){
                        insertFailedTip(currentFatherNode, error.toString() || "翻译失败", spinner);
                    }
                });
        }
    }
}

export function resetTranslationState(): void {
    // 取消所有等待中的翻译任务
    cancelAllTranslations();

    // 停止暴力翻译观察器，并恢复其翻译过的内容（路由切换后视图通常已重建）
    stopBruteForce();
    restoreBruteForceNodes();

    // 停止所有观察器
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }

    // 重置所有翻译相关的状态
    isAutoTranslating = false;
    htmlSet.clear(); // 清空防抖集合
    originalContents.clear(); // 清空原始内容存储
    nodeIdCounter = 0; // 重置节点ID计数器
    normalTranslatedTextNodes = new WeakSet();

    // 移除可能存在的全局样式污染
    const tempStyleElements = document.querySelectorAll('style[data-fr-temp-style]');
    tempStyleElements.forEach(el => el.remove());

    // 注意：不更新域名翻译状态，因为域名翻译状态应保持不变
}

// ==================== 暴力全文翻译 ====================
// 独立于正常翻译链路：不经过站点适配、文本长度/数字/用户名等启发式过滤，
// 直接翻译页面上所有可见文本，并持续跟进动态内容。

const BRUTE_SKIP_SELECTOR = Array.from(BRUTE_SKIP_TAGS).join(',');

/**
 * 暴力全文翻译入口
 * 已激活时只做增量扫描（可重复点击）
 */
export function bruteForceTranslatePage(): { started: boolean; count: number; reason?: 'disabled' | 'not-ready' } {
    if (!config.on) return { started: false, count: 0, reason: 'disabled' };
    if (!document.body) return { started: false, count: 0, reason: 'not-ready' };

    const alreadyActive = bruteForceActive;
    if (!alreadyActive) {
        bruteForceActive = true;
        bruteForceGeneration++;
        updateDomainTranslationState(true);
        document.dispatchEvent(new CustomEvent('fluentread-translation-started'));
    }

    const startCount = bruteQueuedCount;
    collectBruteRoot(document);
    if (!alreadyActive) observeBruteRoot(document.body);
    if (alreadyActive) scheduleBruteFlush();

    return { started: true, count: Math.max(0, bruteQueuedCount - startCount) };
}

// 收集指定根节点下的全部内容（Document 或 open shadow root）
function collectBruteRoot(root: Document | ShadowRoot): void {
    bruteRoots.add(root);
    if (root.nodeType === Node.DOCUMENT_NODE) {
        const body = (root as Document).body;
        if (body) walkBrute(body);
        return;
    }

    (root as ShadowRoot).childNodes.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE) {
            walkBrute(child as Element);
        } else if (child.nodeType === Node.TEXT_NODE) {
            handleBruteTextNode(child as Text);
        }
    });
}

// 递归遍历元素树
function walkBrute(el: Element): void {
    if (!bruteForceActive || !el.isConnected) return;

    // iframe 自身不翻译，但同源 iframe 的文档另外遍历（需在排除判断前处理）
    if (el.tagName.toLowerCase() === 'iframe') {
        attachSameOriginIframe(el as HTMLIFrameElement);
        return;
    }

    if (isExcludedElement(el) || !isElementVisible(el)) return;

    // shadow DOM 是独立树，先处理
    if (el.shadowRoot) {
        observeBruteRoot(el.shadowRoot);
        collectBruteRoot(el.shadowRoot);
    }

    if (config.display === styles.bilingualTranslation) {
        const directTexts = getDirectTextNodes(el);
        // 纯内联子树作为一个双语单元整体翻译，保留链接等结构
        if (directTexts.length > 0 && isPureInlineSubtree(el)) {
            enqueueBilingualUnit(el, el.textContent || '');
            return;
        }
        // 混合内容：只翻译本元素直属文本，再递归子元素
        directTexts.forEach(textNode => enqueueDynamicBilingualText(textNode));
        el.childNodes.forEach(child => {
            if (child.nodeType === Node.ELEMENT_NODE) walkBrute(child as Element);
        });
        return;
    }

    // 仅译文模式
    if (el.childElementCount === 0) {
        const texts = getDirectTextNodes(el);
        if (texts.length === 1) {
            enqueueSingleTextUnit(texts[0]);
        } else if (texts.length > 1) {
            enqueueSingleBlockUnit(el, texts);
        }
    } else {
        // 有子元素时逐个翻译直属文本节点，保留 <a>/<b>/<span> 等结构
        getDirectTextNodes(el).forEach(textNode => enqueueSingleTextUnit(textNode));
    }

    el.childNodes.forEach(child => {
        if (child.nodeType === Node.ELEMENT_NODE) walkBrute(child as Element);
    });
}

// 处理 shadow root 直属的文本节点
function handleBruteTextNode(textNode: Text): void {
    if (config.display === styles.bilingualTranslation) {
        enqueueDynamicBilingualText(textNode);
    } else {
        enqueueSingleTextUnit(textNode);
    }
}

// 直属文本节点（忽略纯空白）
function getDirectTextNodes(el: Element): Text[] {
    const nodes: Text[] = [];
    el.childNodes.forEach(child => {
        if (child.nodeType === Node.TEXT_NODE && (child as Text).textContent?.trim()) {
            nodes.push(child as Text);
        }
    });
    return nodes;
}

// 插件自身 UI、翻译产物、字面禁止翻译的节点
function isExcludedElement(el: Element): boolean {
    if (BRUTE_SKIP_TAGS.has(el.tagName.toLowerCase())) return true;
    if ((el as HTMLElement).isContentEditable) return true;
    if (el.closest(BRUTE_EXTENSION_SELECTOR)) return true;
    if (el.closest('[contenteditable]:not([contenteditable="false"])')) return true;
    if (el.closest('[translate="no"], .notranslate, [aria-hidden="true"]')) return true;
    // 祖先为代码/媒体/表单等标签时也跳过
    if (el.closest(BRUTE_SKIP_SELECTOR)) return true;
    return false;
}

// 是否对用户可见（display:none / visibility:hidden / 无布局盒）
function isElementVisible(el: Element): boolean {
    if (!el.isConnected) return false;
    const view = el.ownerDocument?.defaultView || window;
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false;
    }
    if (style.display === 'contents') return true;
    const anyEl = el as any;
    if (typeof anyEl.checkVisibility === 'function') {
        try {
            if (!anyEl.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
        } catch (e) {
            // 旧浏览器忽略参数错误
        }
    }
    return el.getClientRects().length > 0;
}

// 是否内联元素（决定双语模式能否整块翻译）
function isInlineLike(el: Element): boolean {
    if (inlineSet.has(el.tagName.toLowerCase())) return true;
    try {
        const view = el.ownerDocument?.defaultView || window;
        const display = view.getComputedStyle(el).display;
        return display.startsWith('inline') || display === 'contents' || display === 'ruby';
    } catch (e) {
        return false;
    }
}

function isPureInlineSubtree(el: Element): boolean {
    for (const child of Array.from(el.children)) {
        if (!isElementVisible(child) || isExcludedElement(child) || !isInlineLike(child)) return false;
        if (!isPureInlineSubtree(child)) return false;
    }
    return true;
}

function normalizeBruteText(text: string): string {
    return text.replace(/[\s 　]+/g, ' ').trim();
}

// 是否有可翻译内容：至少 2 个字符、包含字母、且不是目标语言
function isTranslatableSource(source: string): boolean {
    const normalized = normalizeBruteText(source);
    if (normalized.length < 2) return false;
    if (!/\p{L}/u.test(normalized)) return false;
    if (detectlang(normalized.replace(/[\s　]/g, '')) === config.to) return false;
    return true;
}

// 站点或正常链路已翻译、而暴力模式未标记的区域
function hasForeignTranslatedAncestor(el: Element): boolean {
    const marked = el.closest(`[${TRANSLATED_ATTR}="true"]`);
    return !!marked && !bruteMarkedElements.has(marked);
}

// 在修改 DOM 前保存原文并打标记
function markBruteForceElement(el: Element): string {
    const existingId = el.getAttribute(TRANSLATED_ID_ATTR);
    if (existingId && el.getAttribute(TRANSLATED_ATTR) === 'true') {
        return existingId;
    }
    const id = `fr-node-${nodeIdCounter++}`;
    originalContents.set(id, el.innerHTML);
    el.setAttribute(TRANSLATED_ID_ATTR, id);
    el.setAttribute(TRANSLATED_ATTR, 'true');
    bruteMarkedElements.add(el);
    bruteMarkedIds.add(id);
    return id;
}

function unmarkBruteForceElement(el: Element): void {
    const id = el.getAttribute(TRANSLATED_ID_ATTR);
    if (!id || !bruteMarkedIds.has(id)) return;
    originalContents.delete(id);
    bruteMarkedIds.delete(id);
    bruteMarkedElements.delete(el);
    el.removeAttribute(TRANSLATED_ATTR);
    el.removeAttribute(TRANSLATED_ID_ATTR);
    el.classList.remove('fluent-read-bilingual');
}

function isBruteCurrent(generation: number): boolean {
    return bruteForceActive && generation === bruteForceGeneration;
}

function preserveEdgeWhitespace(original: string, translated: string): string {
    const leading = original.match(/^\s*/)?.[0] || '';
    const trailing = original.match(/\s*$/)?.[0] || '';
    return leading + translated.trim() + trailing;
}

// ===== 长文本分块 =====

function chunkBruteText(text: string, max: number = BRUTE_MAX_CHUNK): string[] {
    if (text.length <= max) return [text];
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > max) {
        let cut = -1;
        // 从上限向前找句末标点
        for (let i = max; i > Math.floor(max * 0.5); i--) {
            if (/[.!?。！？;；\n]/.test(rest[i])) {
                cut = i + 1;
                break;
            }
        }
        if (cut === -1) {
            const space = rest.lastIndexOf(' ', max);
            cut = space > 0 ? space + 1 : max;
        }
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    if (rest.trim()) chunks.push(rest);
    return chunks.filter(chunk => chunk.trim());
}

async function translateLongText(text: string): Promise<string> {
    if (text.length <= BRUTE_MAX_CHUNK) {
        return translateText(text, document.title);
    }
    const chunks = chunkBruteText(text);
    const results: string[] = [];
    for (const chunk of chunks) {
        results.push(await translateText(chunk, document.title));
    }
    return results.join(' ');
}

// ===== 翻译单元 =====

// 仅译文模式：翻译单个 Text 节点（原地修改 nodeValue，避免触发观察器循环）
function enqueueSingleTextUnit(textNode: Text): void {
    if (!bruteForceActive) return;
    if (bruteProcessedTextNodes.has(textNode)) return;
    const host = textNode.parentElement;
    if (!host || host.tagName === 'BODY' || host.tagName === 'HTML') return;
    if (isExcludedElement(host) || !isElementVisible(host)) return;
    if (hasForeignTranslatedAncestor(host)) return;

    const original = textNode.textContent || '';
    const source = normalizeBruteText(original);
    if (!isTranslatableSource(source)) {
        bruteProcessedTextNodes.add(textNode);
        return;
    }

    bruteProcessedTextNodes.add(textNode);
    const generation = bruteForceGeneration;
    markBruteForceElement(host);
    bruteQueuedCount++;

    translateLongText(source)
        .then(translated => {
            if (!isBruteCurrent(generation)) return;
            if (!textNode.isConnected) return;
            // 请求期间网站修改了内容，按新内容重新处理
            if (textNode.textContent !== original) {
                bruteProcessedTextNodes.delete(textNode);
                enqueueSingleTextUnit(textNode);
                return;
            }
            if (!translated || normalizeBruteText(translated) === source) return;
            textNode.nodeValue = preserveEdgeWhitespace(original, translated);
        })
        .catch(error => {
            bruteProcessedTextNodes.delete(textNode);
            console.error('[FluentRead][暴力翻译] 翻译失败:', error);
        });
}

// 仅译文模式：同一元素内多个纯文本节点合并为一个翻译单元
function enqueueSingleBlockUnit(host: Element, textNodes: Text[]): void {
    if (!bruteForceActive) return;
    if (isExcludedElement(host) || !isElementVisible(host)) return;
    if (hasForeignTranslatedAncestor(host)) return;

    const pending = textNodes.filter(textNode => !bruteProcessedTextNodes.has(textNode));
    if (!pending.length) return;

    const original = pending.map(textNode => textNode.textContent || '').join('');
    const source = normalizeBruteText(original);
    if (!isTranslatableSource(source)) {
        pending.forEach(textNode => bruteProcessedTextNodes.add(textNode));
        return;
    }

    const generation = bruteForceGeneration;
    pending.forEach(textNode => bruteProcessedTextNodes.add(textNode));
    markBruteForceElement(host);
    bruteQueuedCount++;

    translateLongText(source)
        .then(translated => {
            if (!isBruteCurrent(generation)) return;
            if (!translated || normalizeBruteText(translated) === source) return;
            const connected = pending.filter(textNode => textNode.isConnected);
            if (!connected.length) return;
            // 译文写入第一个文本节点，清空其余文本节点
            connected[0].nodeValue = preserveEdgeWhitespace(connected[0].textContent || '', translated);
            for (let i = 1; i < connected.length; i++) {
                if (connected[i].textContent?.trim()) connected[i].nodeValue = '';
            }
        })
        .catch(error => {
            pending.forEach(textNode => bruteProcessedTextNodes.delete(textNode));
            console.error('[FluentRead][暴力翻译] 翻译失败:', error);
        });
}

// 双语模式：整块翻译（纯内联子树的块元素）
function enqueueBilingualUnit(host: Element, source: string): void {
    if (!bruteForceActive) return;
    if (bruteProcessedElements.has(host)) return;
    if (hasForeignTranslatedAncestor(host)) return;

    const normalized = normalizeBruteText(source);
    if (!isTranslatableSource(normalized)) {
        bruteProcessedElements.add(host);
        return;
    }

    bruteProcessedElements.add(host);
    const generation = bruteForceGeneration;
    const hadMark = host.hasAttribute(TRANSLATED_ATTR);
    markBruteForceElement(host);
    bruteQueuedCount++;

    translateLongText(normalized)
        .then(translated => {
            if (!isBruteCurrent(generation)) return;
            if (!translated || normalizeBruteText(translated) === normalized) {
                if (!hadMark) unmarkBruteForceElement(host);
                return;
            }
            if (!host.isConnected) return;
            bilingualAppendChild(host, translated);
        })
        .catch(error => {
            bruteProcessedElements.delete(host);
            if (!hadMark) unmarkBruteForceElement(host);
            console.error('[FluentRead][暴力翻译] 翻译失败:', error);
        });
}

// 双语模式：混合内容中的单个文本节点（也用于动态新增文本）
function enqueueDynamicBilingualText(textNode: Text): void {
    if (!bruteForceActive) return;
    if (bruteProcessedTextNodes.has(textNode)) return;
    const host = textNode.parentElement;
    if (!host || host.tagName === 'BODY' || host.tagName === 'HTML') return;
    if (isExcludedElement(host) || !isElementVisible(host)) return;
    if (hasForeignTranslatedAncestor(host)) return;

    const original = textNode.textContent || '';
    const source = normalizeBruteText(original);
    if (!isTranslatableSource(source)) {
        bruteProcessedTextNodes.add(textNode);
        return;
    }

    bruteProcessedTextNodes.add(textNode);
    const generation = bruteForceGeneration;
    markBruteForceElement(host);
    bruteQueuedCount++;

    translateLongText(source)
        .then(translated => {
            if (!isBruteCurrent(generation)) return;
            if (!host.isConnected) return;
            if (!translated || normalizeBruteText(translated) === source) return;
            bilingualAppendChild(host, translated);
        })
        .catch(error => {
            bruteProcessedTextNodes.delete(textNode);
            console.error('[FluentRead][暴力翻译] 翻译失败:', error);
        });
}

// ===== 动态内容观察 =====

function observeBruteRoot(root: Node): void {
    if (!root || bruteObservedTargets.has(root)) return;
    bruteObservedTargets.add(root);

    const doc = root.nodeType === Node.DOCUMENT_NODE
        ? root as Document
        : (root as ShadowRoot).ownerDocument;
    const MO = (doc?.defaultView || window).MutationObserver;
    if (!MO) return;

    const observerInstance = new MO((records: MutationRecord[]) => {
        if (!bruteForceActive) return;
        records.forEach(record => {
            if (record.type === 'characterData') {
                const target = record.target;
                if (target.nodeType === Node.TEXT_NODE && !bruteProcessedTextNodes.has(target as Text)) {
                    brutePending.add(target);
                }
            } else if (record.type === 'childList') {
                record.addedNodes.forEach(node => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const el = node as Element;
                        if (el.matches(BRUTE_EXTENSION_SELECTOR) || el.closest(BRUTE_EXTENSION_SELECTOR)) return;
                        brutePending.add(node);
                    } else if (node.nodeType === Node.TEXT_NODE && !bruteProcessedTextNodes.has(node as Text)) {
                        brutePending.add(node);
                    }
                });
            }
        });
        scheduleBruteFlush();
    });

    observerInstance.observe(root, { childList: true, subtree: true, characterData: true });
    bruteObservers.push(observerInstance);
}

function scheduleBruteFlush(): void {
    if (!bruteForceActive) return;
    if (bruteDebounceTimer) clearTimeout(bruteDebounceTimer);
    bruteDebounceTimer = setTimeout(flushBrutePending, BRUTE_DEBOUNCE_MS);
}

function flushBrutePending(): void {
    bruteDebounceTimer = null;
    if (!bruteForceActive) {
        brutePending.clear();
        return;
    }

    const nodes = Array.from(brutePending);
    brutePending.clear();
    nodes.forEach(node => {
        if (!node.isConnected) return;
        if (node.nodeType === Node.TEXT_NODE) {
            handleBruteTextNode(node as Text);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            walkBrute(node as Element);
        }
    });
}

// ===== 同源 iframe =====

function attachSameOriginIframe(iframe: HTMLIFrameElement): void {
    let doc: Document | null = null;
    try {
        doc = iframe.contentDocument;
    } catch (e) {
        doc = null;
    }
    if (!doc) return; // 跨域 iframe 无法访问
    if (bruteIframeDocs.has(doc)) return;
    bruteIframeDocs.add(doc);

    const onLoad = () => {
        if (!bruteForceActive) return;
        collectIframeDocument(iframe);
    };
    iframe.addEventListener('load', onLoad);
    bruteIframeCleanups.push(() => iframe.removeEventListener('load', onLoad));

    collectIframeDocument(iframe);
}

function collectIframeDocument(iframe: HTMLIFrameElement): void {
    let doc: Document | null = null;
    try {
        doc = iframe.contentDocument;
    } catch (e) {
        doc = null;
    }
    if (!doc || !doc.body) return;
    bruteIframeDocs.add(doc);
    collectBruteRoot(doc);
    observeBruteRoot(doc.body);
}

// ===== 停止与恢复 =====

function stopBruteForce(): void {
    bruteForceActive = false;
    bruteForceGeneration++;
    if (bruteDebounceTimer) {
        clearTimeout(bruteDebounceTimer);
        bruteDebounceTimer = null;
    }
    bruteObservers.forEach(observerInstance => observerInstance.disconnect());
    bruteObservers = [];
    bruteIframeCleanups.forEach(cleanup => cleanup());
    bruteIframeCleanups = [];
    bruteObservedTargets = new WeakSet();
    bruteIframeDocs = new WeakSet();
    brutePending.clear();
    bruteQueuedCount = 0;
    // 注意：bruteRoots / 标记注册表保留，由 restoreBruteForceNodes 负责清理
}

function restoreBruteForceNodes(): void {
    const restored = new Set<string>();

    const restoreElement = (el: Element) => {
        const id = el.getAttribute(TRANSLATED_ID_ATTR);
        if (id && !restored.has(id)) {
            const original = originalContents.get(id);
            if (original != null) {
                try {
                    // 暴力模式的原文来自站点自身 DOM，直接回写以避免白名单压平自定义元素/SVG
                    el.innerHTML = bruteMarkedIds.has(id) ? original : sanitizeHTML(original);
                } catch (error) {
                    console.error('[FluentRead][暴力翻译] 恢复原文失败:', error);
                }
                restored.add(id);
            }
        }
        el.removeAttribute(TRANSLATED_ATTR);
        el.removeAttribute(TRANSLATED_ID_ATTR);
        el.classList.remove('fluent-read-bilingual');
    };

    // 只恢复暴力模式自己标记的节点；正常链路节点由 restoreOriginalContent 处理
    // （主文档的已在前面处理，Shadow DOM / 同源 iframe 中的只能从这里恢复）
    bruteMarkedElements.forEach(restoreElement);

    const removeArtifacts = (root: Document | ShadowRoot) => {
        root.querySelectorAll('.fluent-read-bilingual-content, .fluent-read-loading, .fluent-read-retry-wrapper')
            .forEach(el => el.remove());
    };
    removeArtifacts(document);
    bruteRoots.forEach(root => {
        try {
            removeArtifacts(root);
        } catch (e) {
            // 已卸载的 iframe 文档，忽略
        }
    });

    bruteMarkedElements.clear();
    bruteMarkedIds.clear();
    bruteRoots.clear();
    bruteProcessedTextNodes = new WeakSet();
    bruteProcessedElements = new WeakSet();
}
import { checkConfig, searchClassName, skipNode } from "../utils/check";
import { cache } from "../utils/cache";
import { options, servicesType, services } from "../utils/option";
import { insertFailedTip, insertLoadingSpinner } from "../utils/icon";
import { styles } from "@/entrypoints/utils/constant";
import { beautyHTML, grabNode, grabAllNode, LLMStandardHTML, smashTruncationStyle, sanitizeHTML, checkTextSize, isMainlyNumericContent, shouldSkipNode, findTranslatableParent, skipSet } from "@/entrypoints/main/dom";
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

// 恢复原文内容
export function restoreOriginalContent() {
    // 取消所有等待中的翻译任务
    cancelAllTranslations();
    
    // 1. 遍历所有已翻译的节点
    document.querySelectorAll(`[${TRANSLATED_ATTR}="true"]`).forEach(node => {
        const nodeId = node.getAttribute(TRANSLATED_ID_ATTR);
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
    
    // 4. 清空存储的原始内容
    originalContents.clear();
    
    // 5. 停止所有观察器
    if (observer) {
        observer.disconnect();
        observer = null;
    }
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    
    // 6. 重置所有翻译相关的状态
    isAutoTranslating = false;
    htmlSet.clear(); // 清空防抖集合
    nodeIdCounter = 0; // 重置节点ID计数器
    
    // 7. 消除可能存在的全局样式污染
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
    mutationObserver = new MutationObserver((mutations) => {
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

    // 监听整个 body 的变化
    mutationObserver.observe(document.body, {
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

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    const translatedNodes = new Set();

    while (walker.nextNode()) {
        const textNode = walker.currentNode as Text;
        if (!textNode.textContent || !textNode.textContent.trim()) continue;
        // console.log(textNode.textContent);

        // 跳过已翻译的文本节点
        if (translatedNodes.has(textNode)) continue;
        // 没有父节点的跳过
        if (!textNode.parentElement) continue
        
        let currentFatherNode = textNode.parentElement

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
    
    // 移除可能存在的全局样式污染
    const tempStyleElements = document.querySelectorAll('style[data-fr-temp-style]');
    tempStyleElements.forEach(el => el.remove());
    
    // 注意：不更新域名翻译状态，因为域名翻译状态应保持不变
}
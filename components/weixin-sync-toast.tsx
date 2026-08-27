"use client";

// 微信云同步 toast：weixin-cloud-sync 广播的同步事件在这里可视化——
// 拉到新消息、上传本地消息、运行包同步、以及一切失败。挂在桌面壳根部，
// 不管用户停在哪个 App 都看得见，后台同步不再静默。

import { useEffect, useRef, useState } from "react";
import { WEIXIN_SYNC_TOAST_EVENT } from "@/lib/weixin-cloud-sync";

export function WeixinSyncToast() {
    const [text, setText] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    useEffect(() => {
        const onToast = (event: Event) => {
            const detail = (event as CustomEvent).detail as { text?: string; duration?: number } | undefined;
            if (!detail?.text) return;
            setText(detail.text);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setText(null), Math.max(1200, Number(detail.duration) || 2200));
        };
        window.addEventListener(WEIXIN_SYNC_TOAST_EVENT, onToast);
        return () => {
            window.removeEventListener(WEIXIN_SYNC_TOAST_EVENT, onToast);
            clearTimeout(timer.current);
        };
    }, []);

    if (!text) return null;
    // wp-toast 本身是 sticky（为 App 内布局设计），这里作全局浮层改成 fixed 居中
    return (
        <div
            className="wp-toast"
            style={{ position: "fixed", left: "50%", bottom: 28, transform: "translateX(-50%)", zIndex: 3000 }}
        >
            {text}
        </div>
    );
}

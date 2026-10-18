"use client";

import { useRef, useState } from "react";

/**
 * Copy một chuỗi, và cho biết vừa copy xong.
 *
 * Phản hồi là phần không bỏ được: `navigator.clipboard.writeText` không để lại
 * dấu vết nào trên màn hình, nên không có dấu ✓ thì bấm xong người dùng không
 * biết đã ăn hay chưa, và sẽ bấm lại.
 *
 * Giữ `timeout` trong ref chứ không thả trôi: bấm liên tiếp hai lần thì cái hẹn
 * giờ của lần đầu vẫn chạy và tắt dấu ✓ của lần sau sớm hơn nó đáng được — dấu
 * nháy một cái rồi tắt, đọc ra thành "hình như hỏng". Mấy chỗ copy sẵn có trong
 * app đều đang dính đúng lỗi đó.
 */
export function useCopy(ms = 1200) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy(text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard bị chặn (không phải secure context, hoặc người dùng từ chối).
      // Không có gì để nói thêm, và dựng một thông báo lỗi ở đây thì ồn hơn
      // chính việc không copy được.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), ms);
  }

  return { copied, copy };
}

/**
 * Nút copy, đứng **sát** thứ nó copy.
 *
 * Trước đây chỉ có một nút và nó nằm trong cụm bên phải cạnh nút "Chi tiết",
 * cách mã task cả một khoảng `space-between`. Nó copy tiêu đề, nhưng ai nhìn
 * cũng đọc ra là copy mã — vì mã là thứ gần nó nhất theo hàng ngang. Khoảng
 * cách chính là thứ nói cho người dùng biết nút thuộc về cái gì, nên giờ mỗi
 * nút dính liền vào phần chữ của nó.
 *
 * Glyph thôi, không chữ: header panel đã chật. Hiện thường trực chứ không chỉ
 * khi rê chuột — thứ chỉ xuất hiện lúc hover là thứ người dùng không biết là
 * có.
 */
export function CopyBtn({
  text,
  what,
  className = "",
}: {
  text: string;
  /** Tên của thứ được copy, cho tooltip và trình đọc màn hình. */
  what: string;
  className?: string;
}) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      title={copied ? `Đã copy ${what}` : `Copy ${what}`}
      aria-label={`Copy ${what}`}
      className={
        "ml-1 shrink-0 rounded px-1 py-px align-middle text-[11px] leading-none hover:bg-accent-soft hover:text-accent-ink " +
        (copied ? "text-good" : "text-ink-3") +
        (className ? " " + className : "")
      }
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

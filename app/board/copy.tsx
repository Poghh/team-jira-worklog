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
 * Nút copy tiêu đề, đứng cạnh chính tiêu đề đó.
 *
 * Glyph thôi, không chữ: hàng task đã có tám control, và một nút chữ nữa sẽ
 * đẩy phần còn lại hẹp thêm. Vẫn hiện thường trực chứ không chỉ hiện khi rê
 * chuột — thứ chỉ xuất hiện lúc hover là thứ người dùng không biết là có.
 *
 * `self-end` để nó nằm ngang **dòng cuối** của tiêu đề, không phải dòng đầu.
 * Tiêu đề ở đây dài tới hai dòng (`line-clamp-2`), và một nút neo ở dòng đầu
 * trông như thuộc về dòng đó chứ không thuộc về cả khối chữ. Không nhét được
 * nút vào thẳng trong dòng chữ: tiêu đề đã là một `<button>` mở panel chi
 * tiết, mà nút lồng trong nút là HTML không hợp lệ và bàn phím không đi vào
 * được cái bên trong.
 */
export function CopyTitle({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      title={copied ? "Đã copy tiêu đề" : "Copy tiêu đề"}
      aria-label="Copy tiêu đề"
      className={
        "mb-px shrink-0 self-end rounded px-1 py-px text-[11px] leading-none hover:bg-accent-soft hover:text-accent-ink " +
        (copied ? "text-good" : "text-ink-3")
      }
    >
      {copied ? "✓" : "⧉"}
    </button>
  );
}

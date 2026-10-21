import { type StageConfig, type StagePair } from "./model";

/**
 * Cột của bảng, gom lại thành thứ người dùng thật sự khai.
 *
 * Engine đọc một danh sách cột phẳng, và nó đúng là thứ engine cần: mỗi cột
 * một điều kiện, không có khái niệm "môi trường" nào ở tầng ấy. Nhưng người
 * dùng không nghĩ bằng cột — họ nghĩ "tôi có ba môi trường, bốn loại nhánh,
 * một bước review". Ba môi trường ấy là chín cột, và khai bằng tay thì phải
 * nhớ đặt tên đúng khuôn `đã merge X` / `đã build X`, nếu không `envSteps`
 * không nhận ra chúng là một môi trường.
 *
 * Tầng này dịch hai chiều. Nó **không** phải một kiểu lưu mới: nhóm chỉ ôm
 * chính những cột phẳng ấy, nên `fromGroups(toGroups(x)) === x` đúng theo cấu
 * tạo chứ không nhờ cẩn thận. Cột nào không khớp khuôn nào thì thành nhóm
 * `raw` một cột — vẫn hiện, vẫn kéo được, không bị nuốt mất.
 */
export type GroupTag = "kind" | "review" | "env" | "end" | "raw";

export interface StageGroup {
  tag: GroupTag;
  /** Những cột phẳng nhóm này gói, đúng thứ tự engine sẽ đọc. */
  cols: StageConfig[];
}

const stage = (s: Partial<StageConfig>): StageConfig => ({
  name: "",
  expects: "",
  branch: "",
  phase: "",
  reach: "queued",
  kind: "",
  pairs: [],
  ...s,
});

/**
 * Một môi trường là ba cột liền nhau cùng nhánh: chờ PR → đã merge → đã build.
 *
 * Đòi đúng ba cột liền nhau chứ không gom mọi cột cùng nhánh ở bất cứ đâu:
 * thứ tự trong danh sách là đường đi của code, nên ba cột rải rác không phải
 * một môi trường mà là một cấu hình cố ý lệch khuôn — và nó phải hiện ra đúng
 * như thế thay vì bị nhóm này sắp xếp lại giùm.
 */
function envAt(stages: StageConfig[], i: number): StageConfig[] | null {
  const [a, b, c] = [stages[i], stages[i + 1], stages[i + 2]];
  const ok =
    a?.branch &&
    a.reach === "queued" &&
    b?.branch === a.branch &&
    b.reach === "merged" &&
    c?.branch === a.branch &&
    c.reach === "built";
  return ok ? [a, b, c] : null;
}

export function toGroups(stages: StageConfig[]): StageGroup[] {
  const out: StageGroup[] = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const env = envAt(stages, i);
    if (env) {
      out.push({ tag: "env", cols: env });
      i += 2;
    } else if (s.reach === "gone") out.push({ tag: "end", cols: [s] });
    else if (s.branch) out.push({ tag: "raw", cols: [s] });
    else if (s.phase === "open") out.push({ tag: "review", cols: [s] });
    else out.push({ tag: "kind", cols: [s] });
  }
  return out;
}

export const fromGroups = (groups: StageGroup[]): StageConfig[] =>
  groups.flatMap((g) => g.cols);

/* ----------------------------- đọc một nhóm ------------------------------ */

/** Tên người dùng gọi nhóm này. Với môi trường là tên cột "chờ PR". */
export const groupName = (g: StageGroup) => g.cols[0]?.name ?? "";

/** Nhánh dài hạn của nhóm — chỉ môi trường và cột kết thúc mới có. */
export const groupBranch = (g: StageGroup) => g.cols[0]?.branch ?? "";

/** Ngưỡng cảnh báo nhóm đang đặt. Với môi trường là ngưỡng của cột "đã build". */
export const groupExpects = (g: StageGroup): StageConfig["expects"] =>
  (g.tag === "env" ? g.cols[2] : g.cols[0])?.expects ?? "";

export const groupPairs = (g: StageGroup): StagePair[] => g.cols[0]?.pairs ?? [];

export const GROUP_LABEL: Record<GroupTag, string> = {
  kind: "loại nhánh",
  review: "review",
  env: "môi trường",
  end: "kết thúc",
  raw: "cột lẻ",
};

/* ----------------------------- sửa một nhóm ------------------------------ */

const patchCols = (
  g: StageGroup,
  f: (s: StageConfig, i: number) => StageConfig,
): StageGroup => ({ ...g, cols: g.cols.map(f) });

/**
 * Đổi tên nhóm.
 *
 * Môi trường kéo theo cả ba cột, và hai cột sau bị đặt lại đúng khuôn
 * `đã merge X` / `đã build X`. Khuôn ấy không phải thẩm mỹ: `addBuildColumns`
 * sinh cột build bằng đúng tên đó, nên một cặp tên lệch khuôn sẽ khiến cột
 * build thứ hai mọc ra bên cạnh cột đã có.
 */
export const renameGroup = (g: StageGroup, name: string): StageGroup =>
  g.tag === "env"
    ? patchCols(g, (s, i) => ({
        ...s,
        name: i === 0 ? name : `${i === 1 ? "đã merge" : "đã build"} ${name}`,
      }))
    : patchCols(g, (s, i) => (i === 0 ? { ...s, name } : s));

/** Đổi nhánh của môi trường — cả ba cột cùng trỏ một nhánh thì mới là một môi trường. */
export const setGroupBranch = (g: StageGroup, branch: string): StageGroup =>
  patchCols(g, (s) => ({ ...s, branch }));

/**
 * Đặt ngưỡng cảnh báo.
 *
 * Chỉ chạm cột cuối của nhóm — với môi trường đó là cột "đã build", chỗ duy
 * nhất hỏi ngưỡng có nghĩa. Hai cột trước giữ nguyên: card tới "đang chờ PR"
 * mà đã đòi trạng thái test thì mọi card đều lệch, và `migrate` vốn đã sửa
 * ngược lại chính kiểu cấu hình đó.
 */
export const setGroupExpects = (
  g: StageGroup,
  expects: StageConfig["expects"],
): StageGroup =>
  patchCols(g, (s, i) => (i === g.cols.length - 1 ? { ...s, expects } : s));

export const setGroupKind = (g: StageGroup, kind: string): StageGroup =>
  patchCols(g, (s, i) => (i === 0 ? { ...s, kind } : s));

export const setGroupPairs = (g: StageGroup, pairs: StagePair[]): StageGroup =>
  patchCols(g, (s, i) => (i === 0 ? { ...s, pairs } : s));

/* ------------------------------ nhóm mới --------------------------------- */

/**
 * Nhóm mới, rỗng.
 *
 * Để trống tên thay vì đoán một cái: tên cột là thứ card bám vào, và một cột
 * tên "môi trường mới" lỡ lưu xuống thì phải quét lại mới gỡ được.
 */
export function newGroup(tag: Exclude<GroupTag, "raw">): StageGroup {
  if (tag === "env")
    return {
      tag,
      cols: [
        stage({ name: "", expects: "prog" }),
        stage({ name: "đã merge ", expects: "prog", reach: "merged" }),
        stage({ name: "đã build ", expects: "test", reach: "built" }),
      ],
    };
  if (tag === "end")
    return { tag, cols: [stage({ expects: "done", reach: "gone" })] };
  if (tag === "review") return { tag, cols: [stage({ phase: "open" })] };
  return { tag, cols: [stage({ phase: "nopr", expects: "prog" })] };
}

/**
 * Điều khiến nhóm này chưa lưu được, hoặc '' nếu không có.
 *
 * Nhóm môi trường thiếu nhánh là cái bẫy thật sự: `setStages` ép cột không có
 * nhánh về `reach: "queued"`, nên ba cột của nó mất luôn hai bước `đã merge` /
 * `đã build` và lần mở sau chúng hiện ra thành ba dòng loại nhánh rác. Chặn ở
 * đây thay vì sửa giùm lúc lưu — sửa giùm thì người dùng không bao giờ biết
 * mình đã khai thiếu.
 *
 * Cột review chưa có rule nào KHÔNG phải lỗi: đó là trạng thái "chưa khai" có
 * chủ ý, và dòng trên bảng đã nói rõ nó chưa nhận nhánh nào.
 */
export function groupProblem(g: StageGroup): string {
  if (!groupName(g).trim()) return "chưa đặt tên";
  if ((g.tag === "env" || g.tag === "end") && !groupBranch(g).trim())
    return "chưa chọn nhánh";
  return "";
}

/**
 * Đổi loại một dòng, giữ lại những gì còn nghĩa.
 *
 * Tên luôn theo, vì nó là thứ người dùng vừa gõ. Nhánh chỉ theo khi cả hai
 * loại đều dùng tới nhánh — môi trường và kết thúc; mang nhánh sang một dòng
 * loại nhánh thì nó thành cấu hình chết mà vẫn trông như còn tác dụng.
 *
 * Mọi thứ khác dựng lại từ đầu thay vì giữ: một dòng môi trường đổi thành
 * review mà vẫn còn `reach: "built"` trên cột thì nó không còn là dòng review
 * nữa, và lần mở sau nó hiện ra thành cột lẻ.
 */
export function retagGroup(
  g: StageGroup,
  tag: Exclude<GroupTag, "raw">,
): StageGroup {
  if (g.tag === tag) return g;
  const out = renameGroup(newGroup(tag), groupName(g));
  const branch = groupBranch(g);
  return branch && (tag === "env" || tag === "end")
    ? setGroupBranch(out, branch)
    : out;
}

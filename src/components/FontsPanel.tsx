"use client";

import { useRef, useState } from "react";
import {
  type FontFace,
  faceId,
  readFontFiles,
  snapFamily,
} from "@/lib/fonts";

const WEIGHT_OPTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

/** A modal for uploading the design's font files and mapping them to the
 *  families the current selection actually uses. */
export default function FontsPanel({
  designFamilies,
  initial,
  onClose,
  onSave,
}: {
  /** family strings used by the design, with usage counts */
  designFamilies: { family: string; count: number }[];
  initial: FontFace[];
  onClose: () => void;
  onSave: (faces: FontFace[]) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [faces, setFaces] = useState<FontFace[]>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const famList = designFamilies.map((d) => d.family);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const isMatched = (family: string) =>
    faces.some((f) => norm(f.family) === norm(family));

  const addFiles = async (files: FileList | File[]) => {
    setBusy(true);
    setErr(null);
    try {
      const parsed = await readFontFiles(files);
      if (!parsed.length) {
        setErr("Не найдено шрифтов (.woff2 / .woff / .ttf / .otf) в выбранном.");
        return;
      }
      // Snap guessed families onto the design's real names, then de-dupe.
      const snapped = parsed.map((f) => {
        const family = snapFamily(f.family, famList);
        return { ...f, family, id: faceId(family, f.weight, f.style) };
      });
      setFaces((cur) => {
        const map = new Map(cur.map((f) => [f.id, f]));
        for (const f of snapped) map.set(f.id, f);
        return [...map.values()];
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Не удалось прочитать файлы.");
    } finally {
      setBusy(false);
    }
  };

  const update = (id: string, patch: Partial<FontFace>) =>
    setFaces((cur) =>
      cur.map((f) => {
        if (f.id !== id) return f;
        const next = { ...f, ...patch };
        next.id = faceId(next.family, next.weight, next.style);
        return next;
      }),
    );
  const remove = (id: string) => setFaces((cur) => cur.filter((f) => f.id !== id));

  const commit = async () => {
    setBusy(true);
    setErr(null);
    const res = await onSave(faces);
    setBusy(false);
    if (res.ok) onClose();
    else setErr("Не удалось сохранить шрифты: " + (res.error ?? "неизвестная ошибка"));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-white">Шрифты из Figma</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-0.5 text-foreground/50 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3">
          {/* Families the current design needs */}
          <div className="mb-3">
            <div className="mb-1.5 text-xs font-medium text-foreground/60">
              Нужны шрифты для семейств:
            </div>
            {famList.length ? (
              <div className="flex flex-wrap gap-1.5">
                {designFamilies.map((d) => (
                  <span
                    key={d.family}
                    className={`rounded border px-2 py-0.5 text-xs ${
                      isMatched(d.family)
                        ? "border-green-500/50 bg-green-500/10 text-green-300"
                        : "border-border text-foreground/60"
                    }`}
                    title={`${d.count} использований`}
                  >
                    {isMatched(d.family) ? "✓ " : ""}
                    {d.family}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs text-foreground/40">
                В выбранном блоке нет текста — выберите блок со шрифтами.
              </div>
            )}
          </div>

          {/* Upload */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
            }}
            className="mb-3 flex flex-col items-center gap-2 rounded border border-dashed border-border px-4 py-5 text-center"
          >
            <div className="text-xs text-foreground/50">
              Перетащите сюда .zip архив или файлы шрифтов
            </div>
            <button
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="rounded bg-accent px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? "Чтение…" : "Выбрать файлы"}
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept=".woff2,.woff,.ttf,.otf,.zip"
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />
          </div>

          {err && <div className="mb-3 text-xs text-red-400">{err}</div>}

          {/* Loaded faces */}
          {faces.length > 0 && (
            <div className="overflow-hidden rounded border border-border">
              <table className="w-full text-xs">
                <thead className="bg-white/5 text-foreground/50">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">Файл</th>
                    <th className="px-2 py-1.5 text-left font-medium">Семейство</th>
                    <th className="px-2 py-1.5 text-left font-medium">Толщина</th>
                    <th className="px-2 py-1.5 text-left font-medium">Стиль</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {faces.map((f) => (
                    <tr key={f.id} className="border-t border-border">
                      <td
                        className="max-w-[140px] truncate px-2 py-1.5 text-foreground/60"
                        title={f.fileName}
                      >
                        {f.fileName}
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          list="design-families"
                          value={f.family}
                          onChange={(e) => update(f.id, { family: e.target.value })}
                          className="w-full rounded border border-border bg-transparent px-1.5 py-0.5 text-white outline-none focus:border-accent"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          value={f.weight}
                          onChange={(e) =>
                            update(f.id, { weight: Number(e.target.value) })
                          }
                          className="rounded border border-border bg-transparent px-1 py-0.5 text-white outline-none focus:border-accent"
                        >
                          {WEIGHT_OPTS.map((w) => (
                            <option key={w} value={w} className="bg-background">
                              {w}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          value={f.style}
                          onChange={(e) =>
                            update(f.id, {
                              style: e.target.value as "normal" | "italic",
                            })
                          }
                          className="rounded border border-border bg-transparent px-1 py-0.5 text-white outline-none focus:border-accent"
                        >
                          <option value="normal" className="bg-background">
                            normal
                          </option>
                          <option value="italic" className="bg-background">
                            italic
                          </option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          onClick={() => remove(f.id)}
                          className="rounded px-1.5 text-foreground/40 hover:text-red-400"
                          title="Удалить"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id="design-families">
                {famList.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-border px-3 py-1 text-xs text-foreground/70 hover:text-white"
          >
            Отмена
          </button>
          <button
            onClick={commit}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-white"
          >
            Сохранить ({faces.length})
          </button>
        </div>
      </div>
    </div>
  );
}

# Figma Copy

Превращает блоки из Figma в готовый код: **React + Tailwind**, HTML, Vue 3 или
React + CSS-модули. Выделяете фрейм в Figma — получаете вёрстку с живым
превью, картинками, иконками (SVG) и дизайн-токенами. Auto-layout становится
flexbox, переменные Figma — классами вроде `bg-primary-500`.

Основной способ работы — **плагин для Figma**. Ему не нужны ни токен, ни сервер,
ни установка зависимостей.

## Запуск плагина в Figma

1. Скачайте проект: `git clone https://github.com/YpCIIIaK/figma-to-code.git`
   (или *Code → Download ZIP* на GitHub и распакуйте).
2. Откройте **десктопную** Figma (в браузерной версии подключить плагин с диска нельзя).
3. Откройте любой файл, затем меню
   **Plugins → Development → Import plugin from manifest…**
   и выберите файл `figma-plugin/manifest.json` из скачанной папки.
   Это делается один раз.
4. Выделите фрейм (или несколько) и запустите
   **Plugins → Development → Figma Copy — Send to app**.
5. Нажмите **Сгенерировать**, выберите формат и нажмите **Копировать**.

Для превью нужен интернет (Tailwind грузится с CDN).

## Веб-приложение (необязательно)

Нужно для загрузки шрифтов в превью, работы в большом окне и импорта по
ссылке на Figma-файл (тогда понадобится personal access token Figma).

```
npm install
npm run dev
```

Откройте http://localhost:3000. Требуется Node.js 20+.

## Для разработчиков

- `npm test` — тесты конвертера.
- `npm run build:plugin` — пересобрать движок, вшитый в `figma-plugin/ui.html`,
  после правок в `src/lib/figma/` (иначе тесты упадут).

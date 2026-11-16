# ElevenLabs меню для Video Studio

Только код меню и отображения ElevenLabs. Файлы стилей (globals.css, tailwind.config, темы)
намеренно НЕ включены — компоненты используют те же CSS-классы, что и остальная студия.

## Что внутри

Фронт (Next.js + React + Tailwind, lucide-react):

- `web/src/components/voices/voice-picker-row.tsx` — строка «Голос» в окне «Параметры» и
  выпадающее меню выбора голоса: поиск, фильтр по языку, сортировка, табы
  «Мои клоны / Каталог / Стандартные / История», прослушивание образца, история в localStorage.
- `web/src/components/voices/audio-tags-row.tsx` — строка «Аудио-теги» и меню эмоций/тегов
  ElevenLabs v4 (вставка тега в позицию курсора).
- `web/src/components/voices/clone-voice-dialog.tsx` — мастер клонирования голоса
  (имя/язык → сэмплы до 25 МБ → согласие) в том же выпадающем меню.
- `web/src/components/outsee/voice-library-modal.tsx` — полноэкранная библиотека голосов
  (200 русских, 9 стандартных, таб «Мои клоны»), экспортирует `getVoiceById`,
  `resolveVoiceName`, `rememberCloneVoices`.
- `web/src/lib/voice-lab-api.ts` — типы и клиент `/api/voice-lab` (список, создание, правка, удаление).
- `web/src/lib/voice-lab-api.ts`, `audio-tags.ts`, `elevenlabs-voices.ts`, `ru-voices.json` — данные и каталог.

Бэкенд (FastAPI):

- `app/web/routers/voice_lab.py` — реестр клонов и создание у ElevenLabs:
  `GET /api/voice-lab/voices`, `POST /api/voice-lab/clones` (multipart),
  `POST /clones/{id}/preview`, `GET /clones/{id}/preview-audio`, `PATCH`, `DELETE`,
  `GET /clones/{id}/sample`. Хранение — `data/voices/clones/index.json` + файлы, без миграций БД.
- `app/bots/elevenlabs_clone.py` — клиент провайдера (`POST https://api.elevenlabs.io/v1/voices/add`).
- `app/web/routers/voices.py` — отдача образцов каталога (`/api/voices/{id}/sample`).

## Чего нет

- Стилей: CSS-файлов, tailwind-конфига, тем.
- Остальной студии: пайплайна, генераций, оркестратора.

См. `INTEGRATION.md` — как подключить.

# Как подключить

## Фронт

1. Скопировать `web/src/**` в проект с теми же алиасами (`@/` → `web/src`).
2. В окно «Параметры» (компонент настроек модели) добавить два необязательных пропа:

```tsx
renderVoice?: (descriptor: ModelSettingDescriptor) => ReactNode;
panelExtras?: ReactNode;
```

`renderVoice` вызывается для настройки с `kind === "voice"` — вернуть `<VoicePickerRow ... />`.
`panelExtras` рисуется внизу панели — туда идут `<AudioTagsRow onInsertTag={...} />` и кнопка
«Клонировать голос». Так оба меню живут внутри «Параметров», справа от них.

3. Рядом с рабочей областью смонтировать мастер:

```tsx
<CloneVoiceDialog
  open={cloneOpen}
  onOpenChange={setCloneOpen}
  onCreated={(voice, providerError) => { /* обновить список и подставить голос */ }}
/>
```

Геометрия меню: ищут `[data-params-panel]`, встают справа от окна параметров, низ — по низу
параметров, высота в 1.5 раза больше. Дропдауны помечены `data-params-flyout="true"`, чтобы
окно «Параметры» не закрывалось при клике по ним.

## Бэкенд

```python
from app.web.routers import voice_lab
app.include_router(voice_lab.router, prefix="/api")
```

- Подпись ElevenLabs — `ELEVENLABS_API_KEY` в настройках (`settings.elevenlabs_api_key`).
  Без ключа клоны сохраняются локально со статусом `pending_provider` и честным `provider_error`.
- Каталог хранения — `settings.data_dir/voices/clones/`.
- Лимит — 10 созданий в сутки (`429` при превышении).
- Доступ: ручки владельца (`/api/voice-lab`); `/api/voices` разрешён и участникам (образцы каталога).

## Зависимости

Фронт: `react`, `lucide-react`, Tailwind (классы — из проекта-хозяина).
Бэкенд: `fastapi`, `httpx`, `pydantic`, `python-multipart`.

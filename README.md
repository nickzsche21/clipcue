# ClipCue Working MVP

This is a zero-dependency local MVP.

## Run

```powershell
npm start
```

Open:

```txt
http://127.0.0.1:8787
```

## What works

- User enters a startup URL.
- Node server fetches and parses the page.
- App generates a product brief, hooks, script, and storyboard.
- Backend exposes 240 selectable templates through `/api/templates`.
- `/api/generate` accepts `templateId` and returns the selected template metadata.
- Templates vary font pairs, palette, treatment, density, and motion style.
- Browser renders an animated launch-video preview on canvas.
- Browser can record and download a WebM or MP4 preview depending on MediaRecorder support.

## Production next steps

- Replace deterministic generator with an LLM API route.
- Expand generated template families into authored Remotion scene components.
- Replace browser recording with Remotion, Creatomate, or Shotstack for guaranteed MP4.
- Add auth, saved projects, payment gate, and export history.

# Health Tracker (NutriLog)

A mobile-first calorie and nutrition tracker built with React + Vite and packaged as an Android app with Capacitor. You can log a meal by snapping a photo or typing a description, and an AI model estimates calories and macros for you.

## Features

- **AI food logging**: take a photo of a meal or nutrition label, or type a description, to get estimated calories, protein, carbs, fat, sugar and fiber.
- **AI exercise logging**: describe a workout and get a MET-based calorie-burn estimate from your weight, height, age and gender.
- **Steps tracking**: calories burned are worked out from your step count and stride.
- **Daily goals**: set targets for calories, each macro and steps.
- **History**: browse past days, edit entries, or re-add foods and exercises.
- **Backup & restore**: export your data to a JSON file and import it again.
- **Multi-provider fallback**: Claude is tried first, then Gemini 3.7 Flash, then Gemini 2.5 Flash.

## Tech stack

- React 19 + Vite
- Capacitor 8 (Android, Filesystem, Share, Status Bar)
- lucide-react icons
- Anthropic Claude API and Google Gemini API

## Getting started

### Prerequisites

- Node.js 20+
- Android Studio (only needed for the Android build)
- An [Anthropic API key](https://console.anthropic.com/) and/or a [Gemini API key](https://aistudio.google.com/apikey)

### Setup

```bash
git clone <your-repo-url>
cd health-tracker
npm install
cp .env.example .env
```

Open `.env` and fill in your keys:

```
VITE_ANTHROPIC_API_KEY=your-anthropic-key
VITE_GEMINI_API_KEY=your-gemini-key
```

### Run in the browser

```bash
npm run dev
```

### Build the Android app

```bash
npm run build
npx cap sync android
npx cap open android
```

Then build or run the app from Android Studio.

## Security note

The API keys are read from `.env` at **build time** and inlined into the JavaScript bundle. That keeps them out of the source code and out of git, but anyone who has a built copy of the app (`dist/` or the APK) can pull them out. Because of this:

- Never commit `.env`, `dist/`, or APK files (they are already in `.gitignore`).
- Don't share built APKs publicly while they contain your personal keys.
- Set spending limits on your API keys.
- For a public release, send AI requests through a small backend proxy that holds the keys, instead of calling the APIs from the app.

## Project structure

```
├── src/
│   ├── App.jsx        # Whole app: UI, state, AI calls, styles
│   └── main.jsx       # React entry point
├── android/           # Capacitor Android project
├── capacitor.config.json
├── index.html
├── .env.example       # Template for the API keys
└── package.json
```

## Data storage

All logs and goals are kept on the device in `localStorage`. Nothing is sent anywhere except the food and exercise prompts (and photos) sent to the AI provider for estimation.

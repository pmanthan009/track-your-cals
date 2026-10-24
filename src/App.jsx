import React, { useState, useEffect, useRef } from 'react';
import { Home, Target, CalendarClock, Plus, X, Camera, PenLine, Check, Loader2, Trash2, Footprints, ChevronDown, ChevronUp, RotateCcw, Download, Upload, Flame, Utensils, Wheat, Droplet, Candy, Leaf, Settings, LucideBicepsFlexed } from 'lucide-react';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

/* ---------- constants ---------- */
// Loaded from .env at build time (see .env.example). Never commit real keys.
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const ANTHROPIC_API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY;

const DEFAULT_GOALS = { calories: 2000, protein: 120, carbs: 250, fat: 65, sugar: 50, fiber: 30, steps: 8000, weight: 70, height: 170, age: 25, gender: 'male' };

const NUTRIENT_DEFS = [
  { key: 'protein', label: 'Protein', unit: 'g', color: 'var(--c-protein)', icon: LucideBicepsFlexed },
  { key: 'carbs',   label: 'Carbs',   unit: 'g', color: 'var(--c-carbs)', icon: Wheat },
  { key: 'fat',     label: 'Fat',     unit: 'g', color: 'var(--c-fat)', icon: Droplet },
  { key: 'sugar',   label: 'Sugar',   unit: 'g', color: 'var(--c-sugar)', icon: Candy },
  { key: 'fiber',   label: 'Fiber',   unit: 'g', color: 'var(--c-fiber)', icon: Leaf },
];

const EMPTY_DAY = { foods: [], exercises: [], steps: 0 };

// Human-readable labels for whichever model actually served a given request,
// so the UI can show the user what answered instead of a raw model id.
const MODEL_LABELS = {
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'gemini-3.7-flash': 'Gemini 3.7 Flash',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
};

function friendlyModelName(model) {
  return MODEL_LABELS[model] || model || '';
}

/* ---------- helpers ---------- */

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = todayStr();
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yest = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (dateStr === today) return 'Today';
  if (dateStr === yest) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function polarPoint(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function lastNDates(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function kcalBurnedFromSteps(steps, weightKg, heightCm) {
  const w = Number(weightKg) > 0 ? Number(weightKg) : 70;
  const h = Number(heightCm) > 0 ? Number(heightCm) : 170;
  const strideM = h * 0.00415;
  const distanceKm = ((Number(steps) || 0) * strideM) / 1000;
  return Math.round(distanceKm * w * 0.75);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// Downsizes + compresses a gallery photo before it's persisted as the app
// background, so a 12MP camera photo doesn't blow past localStorage's quota.
function fileToResizedDataUrl(file, maxDim = 1280, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round(height * (maxDim / width));
          width = maxDim;
        } else if (height >= width && height > maxDim) {
          width = Math.round(width * (maxDim / height));
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/* ---------- multi-provider api routing ---------- */

async function callClaude(model, prompt, base64 = null, mediaType = null) {
  if (!ANTHROPIC_API_KEY) throw new Error('VITE_ANTHROPIC_API_KEY is not set');
  const content = [];
  
  if (base64) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 }
    });
  }
  
  // Claude doesn't have a strict JSON mode flag like Gemini, so we reinforce the instruction
  const strictPrompt = prompt + "\n\nRespond ONLY with a raw JSON object. Do not include markdown fences (```) or any other text.";
  content.push({ type: 'text', text: strictPrompt });

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true' // Required since we are calling from a React client
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 300,
      messages: [{ role: 'user', content }]
    })
  });

  if (!response.ok) throw new Error(`Claude HTTP ${response.status}`);
  const data = await response.json();
  
  return data.content[0].text;
}

async function callGemini(model, prompt, base64 = null, mediaType = null) {
  if (!GEMINI_API_KEY) throw new Error('VITE_GEMINI_API_KEY is not set');
  const parts = [{ text: prompt }];
  if (base64) {
    parts.push({
      inline_data: { mime_type: mediaType || 'image/jpeg', data: base64 }
    });
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { response_mime_type: "application/json" }
    }),
  });

  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}`);
  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// Returns both the raw text reply AND which model actually produced it, so
// callers (and ultimately the UI) can tell the user what answered — this
// matters since Claude can silently fail over to Gemini underneath.
async function multiProviderFetch(claudeModel, prompt, base64 = null, mediaType = null) {
  // 1. Try Claude First
  try {
    const text = await callClaude(claudeModel, prompt, base64, mediaType);
    return { text, model: claudeModel };
  } catch (claudeErr) {
    console.warn(`Claude (${claudeModel}) failed, falling back to Gemini 3.7 Flash...`, claudeErr);

    // 2. First Fallback: Gemini 3.7 Flash
    try {
      const text = await callGemini("gemini-3.7-flash", prompt, base64, mediaType);
      return { text, model: "gemini-3.7-flash" };
    } catch (gemini37Err) {
      console.warn("Gemini 3.7 Flash failed, falling back to Gemini 2.5 Flash...", gemini37Err);

      // 3. Ultimate Fallback: Gemini 2.5 Flash
      const text = await callGemini("gemini-2.5-flash", prompt, base64, mediaType);
      return { text, model: "gemini-2.5-flash" };
    }
  }
}

// Extracts the first {...} JSON object from a model response, tolerating any
// stray preamble/postamble text (e.g. "Sure, here's the estimate: {...}")
// that models are more prone to add when there's no image anchoring the
// response to "just describe this". Falls back to the raw text if no braces
// are found at all, so JSON.parse still throws a clear error upstream.
function extractJsonObject(rawText) {
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return cleaned;
  return cleaned.slice(start, end + 1);
}

// Updated to handle both text-only and image+text inputs
async function analyzeFood(base64, mediaType, userContext) {
  const basePrompt = base64 
    ? 'You are a careful nutrition estimator. Look at this photo of food or drink and estimate its nutritional content for the visible portion or the label. Respond with ONLY a raw JSON object, no markdown fences, no commentary, no leading or trailing text of any kind, in exactly this shape: {"name": string, "kcal": number, "protein": number, "carbs": number, "fat": number, "sugar": number, "fiber": number, "note": string}. All values are grams except kcal, which is whole kilocalories. "note" is one short sentence describing your portion-size assumption. If multiple items are visible, combine them into a single entry and name it accordingly.'
    : 'You are a careful nutrition estimator. Estimate the nutritional content for this food based on the text description below. Your entire response must be a single raw JSON object and nothing else — no greeting, no explanation, no markdown fences, no leading or trailing text of any kind, in exactly this shape: {"name": string, "kcal": number, "protein": number, "carbs": number, "fat": number, "sugar": number, "fiber": number, "note": string}. All values are grams except kcal. "note" is your portion-size assumption.\n\nFood description:';
  
  const finalPrompt = base64
    ? (userContext ? `User note: ${userContext}. ${basePrompt}` : basePrompt)
    : `${basePrompt} ${userContext}`;
  
  // Use Sonnet for images and complex food evaluations
  const { text: rawText, model: usedModel } = await multiProviderFetch("claude-sonnet-5", finalPrompt, base64, mediaType);
  
  // Robust to any stray preamble/postamble text around the JSON object
  const cleanedText = extractJsonObject(rawText);
  const parsed = JSON.parse(cleanedText);
  
  return {
    name: String(parsed.name || 'Food item'),
    kcal: Math.round(Number(parsed.kcal) || 0),
    protein: Math.round(Number(parsed.protein) || 0),
    carbs: Math.round(Number(parsed.carbs) || 0),
    fat: Math.round(Number(parsed.fat) || 0),
    sugar: Math.round(Number(parsed.sugar) || 0),
    fiber: Math.round(Number(parsed.fiber) || 0),
    note: String(parsed.note || ''),
    model: usedModel,
  };
}

async function analyzeExercise(query, goals) {
  const prompt = `You are a sports science calculator. Estimate the calories burned for this activity: "${query}". 
  User profile: ${goals.weight}kg, ${goals.height}cm, ${goals.age} years old, ${goals.gender}. 
  Use standard MET formulas. Respond with ONLY a raw JSON object, no markdown fences, no commentary, in exactly this shape: {"activity": string, "kcal": number, "duration_minutes": number}.`;
  
  // Use Haiku for rapid, text-only math calculations to save costs
  const { text: rawText, model: usedModel } = await multiProviderFetch("claude-haiku-4-5-20251001", prompt);
  
  const cleanedText = extractJsonObject(rawText);
  const parsed = JSON.parse(cleanedText);
  
  return {
    activity: String(parsed.activity || 'Workout'),
    kcal: Math.round(Number(parsed.kcal) || 0),
    duration: Math.round(Number(parsed.duration_minutes) || 0),
    model: usedModel,
  };
}

async function safeGet(key) {
  try {
    const r = localStorage.getItem(key);
    return r ? r : null;
  } catch (e) {
    return null;
  }
}

/* ---------- small UI pieces ---------- */

function Bar({ pct, color }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="bar-track">
      <div className="bar-fill" style={{ width: clamped + '%', background: color }} />
    </div>
  );
}

function CalorieRing({ consumed, goal, size = 152 }) {
  const stroke = 13;
  const cx = size / 2, cy = size / 2;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const rawPct = goal > 0 ? consumed / goal : 0;
  const pct = Math.min(rawPct, 1);
  const over = goal > 0 && consumed > goal;
  const offset = c * (1 - pct);
  const ticks = [0, 90, 180, 270];
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={over ? 'var(--c-over)' : 'var(--c-accent)'} />
            <stop offset="100%" stopColor={over ? '#FF7A54' : '#EDF1F0'} />
          </linearGradient>
        </defs>
        <circle cx={cx} cy={cy} r={r} className="ring-track" strokeWidth={stroke} fill="none" />
        {ticks.map((deg) => {
          const inner = polarPoint(cx, cy, r - stroke / 2 - 3, deg);
          const outer = polarPoint(cx, cy, r + stroke / 2 + 3, deg);
          return <line key={deg} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} className="ring-tick" />;
        })}
        <circle
          cx={cx} cy={cy} r={r}
          className="ring-fill"
          stroke="url(#ringGradient)"
          strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </svg>
      <div className="ring-center">
        <span className="ring-value">{consumed}</span>
        <span className="ring-goal">of {goal} kcal</span>
      </div>
      <span className={'ring-pct-chip' + (over ? ' over' : '')}>{Math.round(rawPct * 100)}%</span>
    </div>
  );
}

function WeekSparkline({ logs, goals }) {
  const dates = lastNDates(7);
  const bars = dates.map((d) => {
    const dayLog = logs[d] || EMPTY_DAY;
    const consumed = (dayLog.foods || []).reduce((s, f) => s + f.kcal, 0);
    const pct = goals.calories > 0 ? Math.min(consumed / goals.calories, 1.15) : 0;
    const over = goals.calories > 0 && consumed > goals.calories;
    const label = new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'narrow' });
    return { d, consumed, pct, over, label };
  });
  const today = todayStr();
  return (
    <div className="sparkline">
      {bars.map((b) => (
        <div className="sparkline-col" key={b.d}>
          <div className="sparkline-track">
            <div
              className={'sparkline-bar' + (b.over ? ' over' : '') + (b.d === today ? ' current' : '')}
              style={{ height: `${Math.max(b.pct * 100, b.consumed > 0 ? 6 : 2)}%` }}
              title={`${b.consumed} kcal`}
            />
          </div>
          <span className={'sparkline-label' + (b.d === today ? ' current' : '')}>{b.label}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ Icon, title, subtitle }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon"><Icon size={22} /></div>
      <div className="empty-state-title">{title}</div>
      {subtitle && <div className="empty-state-sub">{subtitle}</div>}
    </div>
  );
}

function NutrientRow({ label, value, goal, unit, color, Icon }) {
  const pct = goal > 0 ? (value / goal) * 100 : 0;
  const over = value > goal && goal > 0;
  const remaining = goal - value;
  return (
    <div className="nutrient-row">
      <div className="row-top">
        <span className="row-label">
          {Icon && <Icon size={13} className="row-icon" style={{ color }} />}
          {label}
        </span>
        <span className="row-value">
          {value}{unit} <span className="row-goal">/ {goal}{unit}</span>
        </span>
      </div>
      <Bar pct={pct} color={over ? 'var(--c-over)' : color} />
      {goal > 0 && (
        <div className={'row-remaining' + (over ? ' over' : '')}>
          {over ? `${Math.abs(remaining)}${unit} over goal` : `${remaining}${unit} left`}
        </div>
      )}
    </div>
  );
}

function FoodItem({ food, onRemove, onEdit }) {
  const time = new Date(food.time);
  const timeLabel = isNaN(time) ? '' : time.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="food-item food-item-tappable" onClick={() => onEdit && onEdit(food)}>
      <div className="food-avatar meal"><Utensils size={15} /></div>
      <div className="food-item-main">
        <div className="food-item-top">
          <span className="food-name">{food.name}</span>
          <span className="food-kcal">{food.kcal} kcal</span>
        </div>
        <div className="food-item-sub">
          {timeLabel ? timeLabel + ' · ' : ''}P {food.protein}g · C {food.carbs}g · F {food.fat}g · Sugar {food.sugar}g · Fiber {food.fiber}g
          {food.model && <span className="model-chip">{friendlyModelName(food.model)}</span>}
        </div>
      </div>
      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onRemove(food.id); }} aria-label={`Remove ${food.name}`}>
        <Trash2 size={16} />
      </button>
    </div>
  );
}

function ExerciseItem({ exercise, onRemove, onEdit }) {
  const time = new Date(exercise.time);
  const timeLabel = isNaN(time) ? '' : time.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="food-item food-item-tappable" onClick={() => onEdit && onEdit(exercise)}>
      <div className="food-avatar burn"><Flame size={15} /></div>
      <div className="food-item-main">
        <div className="food-item-top">
          <span className="food-name">{exercise.activity}</span>
          <span className="food-kcal">{exercise.kcal} kcal burned</span>
        </div>
        <div className="food-item-sub">
          {timeLabel ? timeLabel + ' · ' : ''}{exercise.duration} mins
          {exercise.model && <span className="model-chip">{friendlyModelName(exercise.model)}</span>}
        </div>
      </div>
      <button className="icon-btn" onClick={(e) => { e.stopPropagation(); onRemove(exercise.id); }} aria-label={`Remove ${exercise.activity}`}>
        <Trash2 size={16} />
      </button>
    </div>
  );
}

/* ---------- entry modal ---------- */

function EntryModal({ goals, onClose, onSaveFood, onSaveExercise }) {
  const [entryType, setEntryType] = useState('food'); 
  const [mode, setMode] = useState('choose');
  const [error, setError] = useState('');
  
  const [foodQuery, setFoodQuery] = useState('');
  const [foodForm, setFoodForm] = useState({ name: '', kcal: '', protein: '', carbs: '', fat: '', sugar: '', fiber: '', note: '', model: '' });
  const fileInputRef = useRef(null);

  const [exerciseQuery, setExerciseQuery] = useState('');
  const [exerciseForm, setExerciseForm] = useState({ activity: '', kcal: '', duration: '', model: '' });

  const openCamera = () => fileInputRef.current && fileInputRef.current.click();

  const handleFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setMode('analyzing');
    setError('');
    try {
      const base64 = await fileToBase64(file);
      const result = await analyzeFood(base64, file.type || 'image/jpeg', foodQuery);
      setFoodForm({
        name: result.name, kcal: String(result.kcal), protein: String(result.protein),
        carbs: String(result.carbs), fat: String(result.fat), sugar: String(result.sugar),
        fiber: String(result.fiber), note: result.note, model: result.model,
      });
      setMode('form');
    } catch (err) {
      setError("Couldn't read that photo clearly — enter the details manually below.");
      setFoodForm({ name: '', kcal: '', protein: '', carbs: '', fat: '', sugar: '', fiber: '', note: '', model: '' });
      setMode('form');
    }
  };

  const handleTextFoodSubmit = async () => {
    if (!foodQuery.trim()) return;
    setMode('analyzing');
    setError('');
    try {
      const result = await analyzeFood(null, null, foodQuery);
      setFoodForm({
        name: result.name, kcal: String(result.kcal), protein: String(result.protein),
        carbs: String(result.carbs), fat: String(result.fat), sugar: String(result.sugar),
        fiber: String(result.fiber), note: result.note, model: result.model,
      });
      setMode('form');
    } catch (err) {
      setError("Couldn't calculate that — enter the details manually below.");
      setFoodForm({ name: '', kcal: '', protein: '', carbs: '', fat: '', sugar: '', fiber: '', note: '', model: '' });
      setMode('form');
    }
  };

  const handleExerciseSubmit = async () => {
    if (!exerciseQuery.trim()) return;
    setMode('analyzing');
    setError('');
    try {
      const result = await analyzeExercise(exerciseQuery, goals);
      setExerciseForm({
        activity: result.activity,
        kcal: String(result.kcal),
        duration: String(result.duration),
        model: result.model,
      });
      setMode('form');
    } catch (err) {
      setError("Couldn't calculate that — enter the details manually below.");
      setExerciseForm({ activity: '', kcal: '', duration: '', model: '' });
      setMode('form');
    }
  };

  const startManual = () => {
    setError('');
    if (entryType === 'food') setFoodForm({ name: '', kcal: '', protein: '', carbs: '', fat: '', sugar: '', fiber: '', note: '', model: '' });
    if (entryType === 'exercise') setExerciseForm({ activity: '', kcal: '', duration: '', model: '' });
    setMode('form');
  };

  const updateFoodField = (key, val) => setFoodForm(f => ({ ...f, [key]: val }));
  const updateExerciseField = (key, val) => setExerciseForm(f => ({ ...f, [key]: val }));

  const canSaveFood = foodForm.name.trim().length > 0 && foodForm.kcal !== '' && !isNaN(Number(foodForm.kcal));
  const canSaveExercise = exerciseForm.activity.trim().length > 0 && exerciseForm.kcal !== '' && !isNaN(Number(exerciseForm.kcal));

  const handleSave = () => {
    if (entryType === 'food' && canSaveFood) {
      onSaveFood({
        name: foodForm.name.trim(),
        kcal: Math.max(0, Math.round(Number(foodForm.kcal) || 0)),
        protein: Math.max(0, Math.round(Number(foodForm.protein) || 0)),
        carbs: Math.max(0, Math.round(Number(foodForm.carbs) || 0)),
        fat: Math.max(0, Math.round(Number(foodForm.fat) || 0)),
        sugar: Math.max(0, Math.round(Number(foodForm.sugar) || 0)),
        fiber: Math.max(0, Math.round(Number(foodForm.fiber) || 0)),
        model: foodForm.model || null,
      });
      onClose();
    } else if (entryType === 'exercise' && canSaveExercise) {
      onSaveExercise({
        activity: exerciseForm.activity.trim(),
        kcal: Math.max(0, Math.round(Number(exerciseForm.kcal) || 0)),
        duration: Math.max(0, Math.round(Number(exerciseForm.duration) || 0)),
        model: exerciseForm.model || null,
      });
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Log Entry</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {mode === 'choose' && (
          <>
            <div className="type-toggle">
              <button className={entryType === 'food' ? 'btn-primary' : 'btn-ghost'} onClick={() => setEntryType('food')}>Meal</button>
              <button className={entryType === 'exercise' ? 'btn-primary' : 'btn-ghost'} onClick={() => setEntryType('exercise')}>Workout</button>
            </div>

            {entryType === 'food' ? (
              <div className="choose-grid">
                <label className="field" style={{ gridColumn: '1 / -1' }}>
                  <span>Describe your food or context</span>
                  <input type="text" value={foodQuery} onChange={(e) => setFoodQuery(e.target.value)} placeholder="e.g. 200g of paneer tikka" />
                </label>
                <button className="choose-card" onClick={handleTextFoodSubmit} disabled={!foodQuery.trim()} style={{ opacity: foodQuery.trim() ? 1 : 0.5, gridColumn: '1 / -1' }}>
                  <div className="choose-card-icon"><Target size={22} /></div>
                  <span>Calculate from Text</span>
                  <small>No photo needed</small>
                </button>
                <button className="choose-card" onClick={openCamera}>
                  <div className="choose-card-icon"><Camera size={22} /></div>
                  <span>Upload Photo</span>
                  <small>AI scans image</small>
                </button>
                <button className="choose-card" onClick={startManual}>
                  <div className="choose-card-icon"><PenLine size={22} /></div>
                  <span>Enter Manually</span>
                  <small>Type the numbers</small>
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={handleFile} />
              </div>
            ) : (
              <div className="choose-grid">
                <label className="field" style={{ gridColumn: '1 / -1' }}>
                  <span>Describe your workout</span>
                  <input type="text" value={exerciseQuery} onChange={(e) => setExerciseQuery(e.target.value)} placeholder="e.g. ran 5km in 30 mins" />
                </label>
                <button className="choose-card" onClick={handleExerciseSubmit} disabled={!exerciseQuery.trim()} style={{ opacity: exerciseQuery.trim() ? 1 : 0.5 }}>
                  <div className="choose-card-icon"><Target size={22} /></div>
                  <span>Calculate Calories</span>
                  <small>AI applies MET formulas</small>
                </button>
                <button className="choose-card" onClick={startManual}>
                  <div className="choose-card-icon"><PenLine size={22} /></div>
                  <span>Enter manually</span>
                  <small>Add custom burn</small>
                </button>
              </div>
            )}
          </>
        )}

        {mode === 'analyzing' && (
          <div className="analyzing">
            <Loader2 size={28} className="spin" />
            <p>{entryType === 'food' ? 'Analyzing…' : 'Calculating burn…'}</p>
          </div>
        )}

        {mode === 'form' && entryType === 'food' && (
          <div className="entry-form">
            {error && <div className="inline-error">{error}</div>}
            {foodForm.note && <div className="inline-note">{foodForm.note}</div>}
            {foodForm.model && <div className="model-tag">Estimated using {friendlyModelName(foodForm.model)}</div>}
            <label className="field">
              <span>Name</span>
              <input type="text" value={foodForm.name} onChange={(e) => updateFoodField('name', e.target.value)} placeholder="e.g. Grilled chicken bowl" />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>Calories (kcal)</span>
                <input type="number" min="0" value={foodForm.kcal} onChange={(e) => updateFoodField('kcal', e.target.value)} />
              </label>
              {NUTRIENT_DEFS.map(n => (
                <label className="field" key={n.key}>
                  <span>{n.label} ({n.unit})</span>
                  <input type="number" min="0" value={foodForm[n.key]} onChange={(e) => updateFoodField(n.key, e.target.value)} />
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setMode('choose')}>Back</button>
              <button className="btn-primary" disabled={!canSaveFood} onClick={handleSave}>
                <Check size={16} /> Save entry
              </button>
            </div>
          </div>
        )}

        {mode === 'form' && entryType === 'exercise' && (
          <div className="entry-form">
            {error && <div className="inline-error">{error}</div>}
            {exerciseForm.model && <div className="model-tag">Estimated using {friendlyModelName(exerciseForm.model)}</div>}
            <label className="field">
              <span>Activity Name</span>
              <input type="text" value={exerciseForm.activity} onChange={(e) => updateExerciseField('activity', e.target.value)} placeholder="e.g. Running" />
            </label>
            <div className="field-grid">
              <label className="field">
                <span>Calories Burned (kcal)</span>
                <input type="number" min="0" value={exerciseForm.kcal} onChange={(e) => updateExerciseField('kcal', e.target.value)} />
              </label>
              <label className="field">
                <span>Duration (mins)</span>
                <input type="number" min="0" value={exerciseForm.duration} onChange={(e) => updateExerciseField('duration', e.target.value)} />
              </label>
            </div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setMode('choose')}>Back</button>
              <button className="btn-primary" disabled={!canSaveExercise} onClick={handleSave}>
                <Check size={16} /> Save workout
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- edit modal ---------- */

function EditModal({ entry, kind, onClose, onSave, onDelete }) {
  const isFood = kind === 'food';
  const dateFromEntry = (e) => {
    const d = new Date(e.time || Date.now());
    if (isNaN(d)) return todayStr();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const [date, setDate] = useState(dateFromEntry(entry));
  const [foodForm, setFoodForm] = useState(isFood ? {
    name: entry.name || '', kcal: String(entry.kcal ?? ''), protein: String(entry.protein ?? ''),
    carbs: String(entry.carbs ?? ''), fat: String(entry.fat ?? ''), sugar: String(entry.sugar ?? ''),
    fiber: String(entry.fiber ?? ''),
  } : null);
  const [exerciseForm, setExerciseForm] = useState(!isFood ? {
    activity: entry.activity || '', kcal: String(entry.kcal ?? ''), duration: String(entry.duration ?? ''),
  } : null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateFoodField = (key, val) => setFoodForm(f => ({ ...f, [key]: val }));
  const updateExerciseField = (key, val) => setExerciseForm(f => ({ ...f, [key]: val }));

  const canSave = isFood
    ? foodForm.name.trim().length > 0 && foodForm.kcal !== '' && !isNaN(Number(foodForm.kcal))
    : exerciseForm.activity.trim().length > 0 && exerciseForm.kcal !== '' && !isNaN(Number(exerciseForm.kcal));

  const handleSave = () => {
    if (!canSave) return;
    if (isFood) {
      onSave(date, {
        ...entry,
        name: foodForm.name.trim(),
        kcal: Math.max(0, Math.round(Number(foodForm.kcal) || 0)),
        protein: Math.max(0, Math.round(Number(foodForm.protein) || 0)),
        carbs: Math.max(0, Math.round(Number(foodForm.carbs) || 0)),
        fat: Math.max(0, Math.round(Number(foodForm.fat) || 0)),
        sugar: Math.max(0, Math.round(Number(foodForm.sugar) || 0)),
        fiber: Math.max(0, Math.round(Number(foodForm.fiber) || 0)),
      });
    } else {
      onSave(date, {
        ...entry,
        activity: exerciseForm.activity.trim(),
        kcal: Math.max(0, Math.round(Number(exerciseForm.kcal) || 0)),
        duration: Math.max(0, Math.round(Number(exerciseForm.duration) || 0)),
      });
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Edit {isFood ? 'Meal' : 'Workout'}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="entry-form">
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>

          {isFood ? (
            <>
              <label className="field">
                <span>Name</span>
                <input type="text" value={foodForm.name} onChange={(e) => updateFoodField('name', e.target.value)} placeholder="e.g. Grilled chicken bowl" />
              </label>
              <div className="field-grid">
                <label className="field">
                  <span>Calories (kcal)</span>
                  <input type="number" min="0" value={foodForm.kcal} onChange={(e) => updateFoodField('kcal', e.target.value)} />
                </label>
                {NUTRIENT_DEFS.map(n => (
                  <label className="field" key={n.key}>
                    <span>{n.label} ({n.unit})</span>
                    <input type="number" min="0" value={foodForm[n.key]} onChange={(e) => updateFoodField(n.key, e.target.value)} />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span>Activity Name</span>
                <input type="text" value={exerciseForm.activity} onChange={(e) => updateExerciseField('activity', e.target.value)} placeholder="e.g. Running" />
              </label>
              <div className="field-grid">
                <label className="field">
                  <span>Calories Burned (kcal)</span>
                  <input type="number" min="0" value={exerciseForm.kcal} onChange={(e) => updateExerciseField('kcal', e.target.value)} />
                </label>
                <label className="field">
                  <span>Duration (mins)</span>
                  <input type="number" min="0" value={exerciseForm.duration} onChange={(e) => updateExerciseField('duration', e.target.value)} />
                </label>
              </div>
            </>
          )}

          {!confirmDelete ? (
            <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
              <button className="btn-ghost" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={15} /> Delete
              </button>
              <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
                <Check size={16} /> Save changes
              </button>
            </div>
          ) : (
            <div className="confirm-row">
              <span>Delete this entry? This can't be undone.</span>
              <div className="modal-actions">
                <button className="btn-ghost" onClick={() => setConfirmDelete(false)}>Cancel</button>
                <button className="btn-danger" onClick={() => { onDelete(); onClose(); }}>Delete</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- views ---------- */

function TodayView({ dayLog, goals, onRemoveFood, onRemoveExercise, onStepsChange, onEditFood, onEditExercise }) {
  const foods = dayLog.foods || [];
  const exercises = dayLog.exercises || [];
  
  const consumed = foods.reduce((s, f) => s + f.kcal, 0);
  const totals = {};
  NUTRIENT_DEFS.forEach(n => { totals[n.key] = foods.reduce((s, f) => s + (f[n.key] || 0), 0); });
  
  const stepBurn = kcalBurnedFromSteps(dayLog.steps, goals.weight, goals.height);
  const workoutBurn = exercises.reduce((s, e) => s + e.kcal, 0);
  const totalBurned = stepBurn + workoutBurn;
  const net = consumed - totalBurned;
  
  const stepsPct = goals.steps > 0 ? (dayLog.steps / goals.steps) * 100 : 0;

  return (
    <div className="view">
      <div className="panel">
        <div className="panel-title">
          <span>Today's Intake</span>
          <span className="panel-sub">{fmtDateLabel(todayStr())}</span>
        </div>

        <div className="hero-row">
          <CalorieRing consumed={consumed} goal={goals.calories} />
          <div className="hero-stats">
            <div className="hero-stat">
              <span className="hero-stat-label">In</span>
              <span className="hero-stat-value">{consumed} kcal</span>
            </div>
            <div className="hero-stat">
              <span className="hero-stat-label">Out</span>
              <span className="hero-stat-value">{totalBurned} kcal</span>
            </div>
            <div className="hero-stat net">
              <span className="hero-stat-label">Net</span>
              <span className="hero-stat-value">{net}</span>
            </div>
          </div>
        </div>

        <div className="steps-row">
          <div className="steps-top">
            <span className="row-label"><Footprints size={14} className="row-icon" style={{ color: 'var(--c-accent)' }} />Steps</span>
            <input
              type="number" min="0" className="steps-input" value={dayLog.steps || 0}
              onChange={(e) => onStepsChange(Math.max(0, Math.round(Number(e.target.value) || 0)))}
            />
          </div>
          <Bar pct={stepsPct} color="var(--c-accent)" />
          <div className="steps-burn">
            ~{stepBurn} kcal burned
            {dayLog.steps < goals.steps
              ? ` · ${(goals.steps - dayLog.steps).toLocaleString()} steps to go`
              : ' · goal reached'}
          </div>
        </div>

        <div className="nutrient-list">
          {NUTRIENT_DEFS.map(n => (
            <NutrientRow key={n.key} label={n.label} value={totals[n.key]} goal={goals[n.key]} unit={n.unit} color={n.color} Icon={n.icon} />
          ))}
        </div>
      </div>

      <div className="panel food-panel">
        <div className="section-label">Logged Meals</div>
        {foods.length === 0 && <EmptyState Icon={Utensils} title="No meals yet" subtitle="Tap the + button to log your first bite." />}
        {foods.slice().reverse().map((f, i) => (
          <div key={f.id} className="stagger" style={{ animationDelay: `${Math.min(i, 6) * 35}ms` }}>
            <FoodItem food={f} onRemove={onRemoveFood} onEdit={onEditFood} />
          </div>
        ))}
        
        <div className="section-label" style={{marginTop: '24px'}}>Logged Workouts</div>
        {exercises.length === 0 && <EmptyState Icon={Flame} title="No workouts yet" subtitle="Log a session to see it counted here." />}
        {exercises.slice().reverse().map((e, i) => (
          <div key={e.id} className="stagger" style={{ animationDelay: `${Math.min(i, 6) * 35}ms` }}>
            <ExerciseItem exercise={e} onRemove={onRemoveExercise} onEdit={onEditExercise} />
          </div>
        ))}
      </div>
    </div>
  );
}

function GoalsView({ goals, onSave }) {
  const [form, setForm] = useState(goals);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setForm(goals); }, [goals]);

  const update = (key, val) => { setForm(f => ({ ...f, [key]: val })); setSaved(false); };

  const handleSave = () => {
    const cleaned = {
      gender: form.gender || 'male',
      age: Math.max(0, Number(form.age) || 25)
    };
    Object.keys(DEFAULT_GOALS).forEach(k => { 
      if (k !== 'gender' && k !== 'age') {
        cleaned[k] = Math.max(0, Number(form[k]) || 0); 
      }
    });
    onSave(cleaned);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="view">
      <div className="panel">
        <div className="panel-title"><span>Daily Goals & Metrics</span></div>
        <div className="field-grid">
          <label className="field">
            <span>Calories (kcal)</span>
            <input type="number" min="0" value={form.calories} onChange={(e) => update('calories', e.target.value)} />
          </label>
          {NUTRIENT_DEFS.map(n => (
            <label className="field" key={n.key}>
              <span>{n.label} ({n.unit})</span>
              <input type="number" min="0" value={form[n.key]} onChange={(e) => update(n.key, e.target.value)} />
            </label>
          ))}
          <label className="field">
            <span>Steps</span>
            <input type="number" min="0" value={form.steps} onChange={(e) => update('steps', e.target.value)} />
          </label>
          <label className="field" style={{gridColumn: '1 / -1'}}>
            <span style={{color: 'var(--c-accent)', marginBottom: 4}}>Body Profile (For Calorie Math)</span>
          </label>
          <label className="field">
            <span>Age</span>
            <input type="number" min="0" value={form.age} onChange={(e) => update('age', e.target.value)} />
          </label>
          <label className="field">
            <span>Sex</span>
            <select className="field-select" value={form.gender} onChange={(e) => update('gender', e.target.value)}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </label>
          <label className="field">
            <span>Weight (kg)</span>
            <input type="number" min="0" value={form.weight} onChange={(e) => update('weight', e.target.value)} />
          </label>
          <label className="field">
            <span>Height (cm)</span>
            <input type="number" min="0" value={form.height} onChange={(e) => update('height', e.target.value)} />
          </label>
        </div>
        <div className="hint-text">Your profile is only used locally to estimate your stride length and metabolic burn.</div>
        <div className="modal-actions">
          <button className="btn-primary" onClick={handleSave}><Check size={16} /> Save settings</button>
        </div>
        {saved && <div className="inline-note" style={{ marginTop: 10 }}>Settings saved.</div>}
      </div>
    </div>
  );
}

function SettingsView({ onClearData, onDownloadBackup, onRestore, bgImage, onSetBgImage, onClearBgImage }) {
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingRestore, setPendingRestore] = useState(null);
  const [restoreError, setRestoreError] = useState('');
  const [bgLoading, setBgLoading] = useState(false);
  const [bgError, setBgError] = useState('');
  const restoreInputRef = useRef(null);
  const bgInputRef = useRef(null);

  const openRestorePicker = () => restoreInputRef.current && restoreInputRef.current.click();
  const openBgPicker = () => bgInputRef.current && bgInputRef.current.click();

  const handleBgFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setBgError('');
    setBgLoading(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      onSetBgImage(dataUrl);
    } catch (err) {
      setBgError("Couldn't load that photo — try a different one.");
    } finally {
      setBgLoading(false);
    }
  };

  const handleRestoreFile = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setRestoreError('');
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || typeof parsed !== 'object' || (!parsed.goals && !parsed.logs)) {
          throw new Error('unexpected shape');
        }
        setPendingRestore(parsed);
      } catch (err) {
        setRestoreError("That file doesn't look like a NutriLog backup.");
      }
    };
    reader.onerror = () => setRestoreError("Couldn't read that file.");
    reader.readAsText(file);
  };

  const confirmRestore = () => {
    onRestore(pendingRestore);
    setPendingRestore(null);
  };

  return (
    <div className="view">
      <div className="panel">
        <div className="panel-title small"><span>Appearance</span></div>
        <div className="bg-picker-row">
          <div className="bg-preview">
            {bgImage
              ? <img src={bgImage} alt="Custom background" className="bg-preview-img" />
              : <span className="bg-preview-empty">Default</span>}
          </div>
          <div className="bg-picker-actions">
            <button className="btn-ghost" onClick={openBgPicker} disabled={bgLoading}>
              {bgLoading ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}
              {bgLoading ? 'Loading…' : bgImage ? 'Change photo' : 'Choose from gallery'}
            </button>
            {bgImage && (
              <button className="btn-ghost" onClick={onClearBgImage} disabled={bgLoading}>
                <RotateCcw size={15} /> Use default
              </button>
            )}
            <input ref={bgInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleBgFile} />
          </div>
        </div>
        <div className="hint-text" style={{ marginTop: 10, marginBottom: 0 }}>Pick a photo from your gallery to use as the app background. It's resized and stored on your device only.</div>
        {bgError && <div className="inline-error" style={{ marginTop: 10 }}>{bgError}</div>}
      </div>

      <div className="panel">
        <div className="panel-title small"><span>Backup</span></div>
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
          <button className="btn-ghost" onClick={onDownloadBackup}>
            <Download size={15} /> Download backup
          </button>
          <button className="btn-ghost" onClick={openRestorePicker}>
            <Upload size={15} /> Restore from backup
          </button>
          <input ref={restoreInputRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={handleRestoreFile} />
        </div>
        <div className="hint-text" style={{ marginTop: 8, marginBottom: 0 }}>Restoring overwrites your current goals and logs with what's in the file.</div>
        {restoreError && <div className="inline-error" style={{ marginTop: 10 }}>{restoreError}</div>}
        {pendingRestore && (
          <div className="confirm-row" style={{ marginTop: 10 }}>
            <span>
              Restore backup{pendingRestore.exportedAt ? ` from ${new Date(pendingRestore.exportedAt).toLocaleDateString()}` : ''}?
              This replaces your current goals and logs — it can't be undone.
            </span>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setPendingRestore(null)}>Cancel</button>
              <button className="btn-primary" onClick={confirmRestore}><Check size={16} /> Restore</button>
            </div>
          </div>
        )}
      </div>

      <div className="panel danger-panel">
        <div className="panel-title small"><span>Reset</span></div>
        <div className="hint-text" style={{ color: 'var(--c-over-text)', marginBottom: '12px' }}>
          Warning: This action will permanently delete all your logged entries and settings. It cannot be undone.
        </div>
        {!confirmClear ? (
          <button className="btn-ghost" onClick={() => setConfirmClear(true)}>
            <RotateCcw size={15} /> Clear all logged data
          </button>
        ) : (
          <div className="confirm-row">
            <span>Are you absolutely sure you want to delete everything?</span>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="btn-danger" onClick={() => { onClearData(); setConfirmClear(false); }}>Delete everything</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryRow({ date, dayLog, goals, onReaddFood, onReaddExercise, onEditFood, onEditExercise, onStepsChange }) {
  const [open, setOpen] = useState(false);
  const foods = dayLog.foods || [];
  const exercises = dayLog.exercises || [];
  
  const consumed = foods.reduce((s, f) => s + f.kcal, 0);
  const stepBurn = kcalBurnedFromSteps(dayLog.steps, goals.weight, goals.height);
  const workoutBurn = exercises.reduce((s, e) => s + e.kcal, 0);
  const burned = stepBurn + workoutBurn;
  const ratioPct = goals.calories > 0 ? (consumed / goals.calories) * 100 : 0;
  const over = goals.calories > 0 && consumed > goals.calories;

  return (
    <div className="history-row">
      <button className="history-summary" onClick={() => setOpen(o => !o)}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="history-date">{fmtDateLabel(date)}</div>
          <div className="history-sub">{consumed} kcal in · {burned} kcal out · {(dayLog.steps || 0).toLocaleString()} steps</div>
          <div className="history-ratio-track"><div className="history-ratio-fill" style={{ width: `${Math.min(ratioPct, 100)}%`, background: over ? 'var(--c-over)' : 'var(--c-good)' }} /></div>
        </div>
        {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      {open && (
        <div className="history-detail">
          <div className="history-steps-row">
            <span className="row-label"><Footprints size={13} className="row-icon" style={{ color: 'var(--c-accent)' }} />Steps</span>
            <input
              type="number" min="0" className="steps-input" value={dayLog.steps || 0}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onStepsChange(date, Math.max(0, Math.round(Number(e.target.value) || 0)))}
            />
          </div>

          {foods.length === 0 && exercises.length === 0 && <div className="empty-note">No entries.</div>}
          
          {foods.map(f => (
            <div className="history-food" key={f.id} onClick={(e) => { e.stopPropagation(); onEditFood(f); }}>
              <span>{f.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{f.kcal} kcal</span>
                <button className="icon-btn" style={{padding: '2px'}} onClick={(e) => { e.stopPropagation(); onReaddFood(f); }} aria-label="Add to today">
                  <Plus size={16} />
                </button>
              </div>
            </div>
          ))}
          
          {exercises.map(exercise => (
            <div className="history-food" key={exercise.id} onClick={(e) => { e.stopPropagation(); onEditExercise(exercise); }}>
              <span><Flame size={12} style={{ display: 'inline', verticalAlign: '-1px', color: 'var(--c-over-text)', marginRight: '4px' }} />{exercise.activity}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{exercise.kcal} kcal</span>
                <button className="icon-btn" style={{padding: '2px'}} onClick={(e) => { e.stopPropagation(); onReaddExercise(exercise); }} aria-label="Add to today">
                  <Plus size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryView({ logs, goals, onReaddFood, onReaddExercise, onEditFood, onEditExercise, onStepsChange }) {
  const today = todayStr();
  const dates = Object.keys(logs).filter(d => d !== today).sort().reverse();
  return (
    <div className="view">
      <div className="panel">
        <div className="panel-title"><span>Last 7 Days</span></div>
        <WeekSparkline logs={logs} goals={goals} />
      </div>
      <div className="panel">
        <div className="panel-title"><span>History</span></div>
        {dates.length === 0 && <EmptyState Icon={CalendarClock} title="Nothing here yet" subtitle="Past days will show up here once today ends." />}
        {dates.map(d => (
          <HistoryRow
            key={d} date={d} dayLog={logs[d]} goals={goals}
            onReaddFood={onReaddFood} onReaddExercise={onReaddExercise}
            onEditFood={onEditFood} onEditExercise={onEditExercise}
            onStepsChange={onStepsChange}
          />
        ))}
      </div>
    </div>
  );
}

function BottomNav({ tab, setTab, onAdd }) {
  return (
    <nav className="bottom-nav">
      <button className={'nav-btn' + (tab === 'today' ? ' active' : '')} onClick={() => setTab('today')}>
        <span className="nav-dot" /><Home size={19} /><span>Today</span>
      </button>
      <button className={'nav-btn' + (tab === 'history' ? ' active' : '')} onClick={() => setTab('history')}>
        <span className="nav-dot" /><CalendarClock size={19} /><span>History</span>
      </button>
      <button className="fab" onClick={onAdd} aria-label="Log entry"><Plus size={24} /></button>
      <button className={'nav-btn' + (tab === 'goals' ? ' active' : '')} onClick={() => setTab('goals')}>
        <span className="nav-dot" /><Target size={19} /><span>Goals</span>
      </button>
      <button className={'nav-btn' + (tab === 'settings' ? ' active' : '')} onClick={() => setTab('settings')}>
        <span className="nav-dot" /><Settings size={19} /><span>Settings</span>
      </button>
    </nav>
  );
}

/* ---------- app ---------- */

export default function App() {
  const [ready, setReady] = useState(false);
  const [goals, setGoals] = useState(DEFAULT_GOALS);
  const [logs, setLogs] = useState({});
  const [tab, setTab] = useState('today');
  const [showEntry, setShowEntry] = useState(false);
  const [toast, setToast] = useState('');
  const [bgImage, setBgImageState] = useState(null);
  const [editingEntry, setEditingEntry] = useState(null); // { kind: 'food'|'exercise', originalDate, entry }

  const today = todayStr();

  // Manual-only steps entry. Writes into whatever date is passed in, so the
  // same function backs both today's quick input and any past day's steps
  // edited from History.
  const setStepsForDate = (date, steps) => {
    setLogs(prevLogs => {
      const dayLog = prevLogs[date] || EMPTY_DAY;
      const updated = { ...prevLogs, [date]: { ...dayLog, steps } };
      try { localStorage.setItem('logs', JSON.stringify(updated)); } catch (e) { flashToast("Couldn't save — try again."); }
      return updated;
    });
  };

  const setSteps = (steps) => setStepsForDate(today, steps);

  useEffect(() => {
    (async () => {
      const g = await safeGet('goals');
      if (g) { try { setGoals({ ...DEFAULT_GOALS, ...JSON.parse(g) }); } catch (e) {} }
      const l = await safeGet('logs');
      if (l) { try { setLogs(JSON.parse(l)); } catch (e) {} }
      const bg = await safeGet('bgImage');
      if (bg) setBgImageState(bg);
      setReady(true);
    })();
  }, []);

  const flashToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200); };

  const setBgImage = (dataUrl) => {
    setBgImageState(dataUrl);
    try { localStorage.setItem('bgImage', dataUrl); } catch (e) { flashToast("Couldn't save that photo — it may be too large."); }
  };

  const clearBgImage = () => {
    setBgImageState(null);
    try { localStorage.removeItem('bgImage'); } catch (e) {}
  };

  const persistGoals = async (newGoals) => {
    setGoals(newGoals);
    try { localStorage.setItem('goals', JSON.stringify(newGoals)); } catch (e) { flashToast("Couldn't save goals — try again."); }
  };

  const persistLogs = async (newLogs) => {
    setLogs(newLogs);
    try { localStorage.setItem('logs', JSON.stringify(newLogs)); } catch (e) { flashToast("Couldn't save — try again."); }
  };

  const todayLog = logs[today] || EMPTY_DAY;

  const addFood = (food) => {
    const { id, time, ...restFood } = food; 
    const entry = { ...restFood, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString() };
    const dayLog = logs[today] || EMPTY_DAY;
    const currentFoods = dayLog.foods || [];
    persistLogs({ ...logs, [today]: { ...dayLog, foods: [...currentFoods, entry] } });
    flashToast('Food added!');
  };

  const removeFood = (id) => {
    const dayLog = logs[today] || EMPTY_DAY;
    const currentFoods = dayLog.foods || [];
    persistLogs({ ...logs, [today]: { ...dayLog, foods: currentFoods.filter(f => f.id !== id) } });
  };

  const addExercise = (exercise) => {
    const { id, time, ...restEx } = exercise;
    const entry = { ...restEx, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString() };
    const dayLog = logs[today] || EMPTY_DAY;
    const currentExercises = dayLog.exercises || [];
    persistLogs({ ...logs, [today]: { ...dayLog, exercises: [...currentExercises, entry] } });
    flashToast('Workout added!');
  };

  const removeExercise = (id) => {
    const dayLog = logs[today] || EMPTY_DAY;
    const currentExercises = dayLog.exercises || [];
    persistLogs({ ...logs, [today]: { ...dayLog, exercises: currentExercises.filter(e => e.id !== id) } });
  };

  // Finds which date a food entry currently lives under, by id.
  const findFoodDate = (id) => {
    for (const d of Object.keys(logs)) {
      if ((logs[d].foods || []).some(f => f.id === id)) return d;
    }
    return today;
  };
  const findExerciseDate = (id) => {
    for (const d of Object.keys(logs)) {
      if ((logs[d].exercises || []).some(e => e.id === id)) return d;
    }
    return today;
  };

  const openEditFood = (food) => {
    setEditingEntry({ kind: 'food', originalDate: findFoodDate(food.id), entry: food });
  };
  const openEditExercise = (exercise) => {
    setEditingEntry({ kind: 'exercise', originalDate: findExerciseDate(exercise.id), entry: exercise });
  };

  // Saves an edited food entry, moving it between dates if the date changed.
  const saveEditedFood = (newDate, updatedFood) => {
    const originalDate = findFoodDate(updatedFood.id);
    const newLogs = { ...logs };
    // Remove from its original day
    const originalDay = newLogs[originalDate] || EMPTY_DAY;
    newLogs[originalDate] = { ...originalDay, foods: (originalDay.foods || []).filter(f => f.id !== updatedFood.id) };
    // Insert into the (possibly new) target day
    const targetDay = newLogs[newDate] || EMPTY_DAY;
    // If the date changed, refresh the time to match the new date while keeping time-of-day
    let entryToStore = updatedFood;
    if (newDate !== originalDate) {
      const oldTime = new Date(updatedFood.time || Date.now());
      const [y, m, d] = newDate.split('-').map(Number);
      const newTime = isNaN(oldTime) ? new Date(y, m - 1, d) : new Date(y, m - 1, d, oldTime.getHours(), oldTime.getMinutes(), oldTime.getSeconds());
      entryToStore = { ...updatedFood, time: newTime.toISOString() };
    }
    newLogs[newDate] = { ...targetDay, foods: [...(targetDay.foods || []), entryToStore] };
    persistLogs(newLogs);
    flashToast('Meal updated.');
  };

  const saveEditedExercise = (newDate, updatedExercise) => {
    const originalDate = findExerciseDate(updatedExercise.id);
    const newLogs = { ...logs };
    const originalDay = newLogs[originalDate] || EMPTY_DAY;
    newLogs[originalDate] = { ...originalDay, exercises: (originalDay.exercises || []).filter(e => e.id !== updatedExercise.id) };
    const targetDay = newLogs[newDate] || EMPTY_DAY;
    let entryToStore = updatedExercise;
    if (newDate !== originalDate) {
      const oldTime = new Date(updatedExercise.time || Date.now());
      const [y, m, d] = newDate.split('-').map(Number);
      const newTime = isNaN(oldTime) ? new Date(y, m - 1, d) : new Date(y, m - 1, d, oldTime.getHours(), oldTime.getMinutes(), oldTime.getSeconds());
      entryToStore = { ...updatedExercise, time: newTime.toISOString() };
    }
    newLogs[newDate] = { ...targetDay, exercises: [...(targetDay.exercises || []), entryToStore] };
    persistLogs(newLogs);
    flashToast('Workout updated.');
  };

  const deleteEditingEntry = () => {
    if (!editingEntry) return;
    if (editingEntry.kind === 'food') removeFoodFromDate(editingEntry.originalDate, editingEntry.entry.id);
    else removeExerciseFromDate(editingEntry.originalDate, editingEntry.entry.id);
  };

  const removeFoodFromDate = (date, id) => {
    const dayLog = logs[date] || EMPTY_DAY;
    persistLogs({ ...logs, [date]: { ...dayLog, foods: (dayLog.foods || []).filter(f => f.id !== id) } });
    flashToast('Meal deleted.');
  };

  const removeExerciseFromDate = (date, id) => {
    const dayLog = logs[date] || EMPTY_DAY;
    persistLogs({ ...logs, [date]: { ...dayLog, exercises: (dayLog.exercises || []).filter(e => e.id !== id) } });
    flashToast('Workout deleted.');
  };

  const downloadBackup = async () => {
    try {
      const payload = { exportedAt: new Date().toISOString(), goals, logs };
      const fileName = `nutrilog-backup-${today}.json`;
      const jsonString = JSON.stringify(payload, null, 2);

      try {
        // 1. Check and request storage permissions (needed on some Android versions)
        const perm = await Filesystem.checkPermissions();
        if (perm.publicStorage !== 'granted') {
          await Filesystem.requestPermissions();
        }

        // 2. Write directly to the phone's public Documents folder
        await Filesystem.writeFile({
          path: fileName,
          data: jsonString,
          directory: Directory.Documents,
          encoding: Encoding.UTF8
        });

        // Let the user know exactly where it went!
        flashToast('Saved to your Documents folder!');
        
      } catch (nativeError) {
        // Fallback for desktop web browser testing
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      flashToast("Couldn't create the backup file.");
      console.error(e);
    }
  };

  const restoreBackup = async (payload) => {
    const newGoals = { ...DEFAULT_GOALS, ...(payload.goals && typeof payload.goals === 'object' ? payload.goals : {}) };
    const newLogs = (payload.logs && typeof payload.logs === 'object') ? payload.logs : {};
    setGoals(newGoals);
    setLogs(newLogs);
    try { localStorage.setItem('goals', JSON.stringify(newGoals)); } catch (e) { flashToast("Couldn't save restored goals."); }
    try { localStorage.setItem('logs', JSON.stringify(newLogs)); } catch (e) { flashToast("Couldn't save restored logs."); }
    flashToast('Backup restored.');
  };

  const clearAllData = async () => {
    setLogs({});
    setGoals(DEFAULT_GOALS);
    try { localStorage.removeItem('logs'); } catch (e) {}
    try { localStorage.removeItem('goals'); } catch (e) {}
    flashToast('All data cleared.');
  };

  if (!ready) {
    return (
      <div className="nutriapp">
        <style>{CSS}</style>
        <div className="loading-screen"><Loader2 size={24} className="spin" /><span>Loading your log…</span></div>
      </div>
    );
  }

  return (
    <div className="nutriapp">
      <style>{CSS}</style>
      <div
        className={'app-shell' + (bgImage ? ' has-bg-photo' : '')}
        style={bgImage ? { backgroundImage: `url(${bgImage})` } : undefined}
      >
        {bgImage && <div className="bg-scrim" />}
        {!bgImage && (
          <>
            <div className="aurora-orb orb-1" />
            <div className="aurora-orb orb-2" />
            <div className="aurora-orb orb-3" />
          </>
        )}
        <header className="app-header">
          <span className="app-title">Track Your Cals</span>
          <span className="app-tagline">Don't eat SHIT & be fucking ACTIVE</span>
        </header>
        <main className="app-main">
          {tab === 'today' && (
            <TodayView
              dayLog={todayLog} goals={goals}
              onRemoveFood={removeFood} onRemoveExercise={removeExercise}
              onStepsChange={setSteps}
              onEditFood={openEditFood} onEditExercise={openEditExercise}
            />
          )}
          {tab === 'goals' && <GoalsView goals={goals} onSave={persistGoals} />}
          {tab === 'history' && (
            <HistoryView
              logs={logs} goals={goals}
              onReaddFood={addFood} onReaddExercise={addExercise}
              onEditFood={openEditFood} onEditExercise={openEditExercise}
              onStepsChange={setStepsForDate}
            />
          )}
          {tab === 'settings' && <SettingsView onClearData={clearAllData} onDownloadBackup={downloadBackup} onRestore={restoreBackup} bgImage={bgImage} onSetBgImage={setBgImage} onClearBgImage={clearBgImage} />}
        </main>
        <BottomNav tab={tab} setTab={setTab} onAdd={() => setShowEntry(true)} />
        {showEntry && <EntryModal goals={goals} onClose={() => setShowEntry(false)} onSaveFood={addFood} onSaveExercise={addExercise} />}
        {editingEntry && (
          <EditModal
            entry={editingEntry.entry}
            kind={editingEntry.kind}
            onClose={() => setEditingEntry(null)}
            onSave={editingEntry.kind === 'food' ? saveEditedFood : saveEditedExercise}
            onDelete={deleteEditingEntry}
          />
        )}
        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}

/* ---------- styles ---------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600;700&family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;0,9..144,700;0,9..144,900;1,9..144,500;1,9..144,600&family=JetBrains+Mono:wght@400;500;600;700&display=swap');

html, body, #root {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  background-color: #131C27;
  overflow: hidden;
}

.nutriapp { position: relative; }
.nutriapp::before {
  content: '';
  position: fixed; inset: 0; pointer-events: none; z-index: 1; opacity: 0.05; mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='90' height='90'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.app-shell { position: relative; z-index: 2; }

.nutriapp {
  --paper: #223349;
  --paper-2: #263B4D;
  --paper-3: #2A3F52;
  --badge-bg: #2D4356;
  --ink: #EDF1F0;
  --ink-dim: #9FB0BC;
  --ink-faint: #d2dde5;
  --line: rgba(62,85,104,0.55);
  --line-strong: #3E5568;
  --c-accent: #07f6de;
  --c-accent-soft: rgba(0,230,195,0.20);
  --c-good: #29D2FF;
  --c-over: #24097c;
  --c-over-text: #FF7A54;
  --c-over-soft: rgba(255,76,41,0.20);
  --c-protein: #d50707b8;
  --c-carbs: #0ca02c;
  --c-fat: #108cd9c6;
  --c-sugar: #a60e7e;
  --c-fiber: #bab50c;
  --shadow-soft: 0 20px 44px -20px rgba(6,10,8,0.55);
  --radius: 16px;
  --font-display: 'Fraunces', serif;
  --font-body: 'Work Sans', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  background: var(--paper);
  color: var(--ink);
  font-family: var(--font-body);
  min-height: 100vh;
  display: flex;
  justify-content: center;
}

.nutriapp * { box-sizing: border-box; }

.app-shell {
  width: 100%;
  max-width: 100%;
  height: 100vh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  position: relative;
  background: linear-gradient(180deg, #1B2733 0%, #131C27 100%);
  overflow: hidden;
}
.app-shell.has-bg-photo {
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.bg-scrim {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: linear-gradient(180deg, rgba(10,16,24,0.72) 0%, rgba(10,16,24,0.45) 35%, rgba(10,16,24,0.55) 70%, rgba(10,16,24,0.82) 100%);
}

.loading-screen {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  height: 100vh; font-family: var(--font-body); color: var(--ink-dim);
  background: linear-gradient(180deg, #1B2733 0%, #131C27 100%);
}

.aurora-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(70px);
  pointer-events: none;
  z-index: 0;
  will-change: transform;
}
.aurora-orb.orb-1 {
  width: 320px; height: 320px;
  top: -70px; left: -70px;
  background: radial-gradient(circle, rgba(0,230,195,0.45), transparent 70%);
  animation: drift1 22s ease-in-out infinite alternate;
}
.aurora-orb.orb-2 {
  width: 360px; height: 360px;
  top: 100px; right: -110px;
  background: radial-gradient(circle, rgba(91,127,255,0.40), transparent 70%);
  animation: drift2 26s ease-in-out infinite alternate;
}
.aurora-orb.orb-3 {
  width: 300px; height: 300px;
  bottom: -90px; left: 20px;
  background: radial-gradient(circle, rgba(255,76,41,0.32), transparent 70%);
  animation: drift3 30s ease-in-out infinite alternate;
}
@keyframes drift1 {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(50px, 70px) scale(1.18); }
}
@keyframes drift2 {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(-60px, 50px) scale(0.88); }
}
@keyframes drift3 {
  from { transform: translate(0, 0) scale(1); }
  to { transform: translate(35px, -60px) scale(1.12); }
}

.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.app-header {
  position: relative; z-index: 2;
  padding: calc(22px + env(safe-area-inset-top, 24px)) 22px 16px;
  border-bottom: 1px solid var(--line);
}
.app-title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.7rem;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.app-tagline {
  display: block;
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 500;
  font-size: 0.86rem;
  color: var(--c-accent);
  margin-top: 3px;
  letter-spacing: 0.01em;
}

.app-main {
  position: relative; z-index: 2;
  flex: 1;
  overflow-y: auto;
  padding: 18px 16px calc(118px + env(safe-area-inset-bottom, 24px));
  animation: fadein 0.25s ease;
}
@keyframes fadein { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

.view { display: flex; flex-direction: column; gap: 16px; }

.panel {
  background: radial-gradient(circle at 25% 0%, rgba(51,73,93,0.2) 0%, rgba(38,59,77,0.15) 55%, rgba(30,44,58,0.2) 100%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: var(--radius);
  padding: 20px;
  box-shadow: var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.06);
}
.danger-panel { border-color: rgba(255,76,41,0.4); }

.bg-picker-row { display: flex; align-items: center; gap: 14px; }
.bg-preview {
  width: 64px; height: 64px; border-radius: 14px; flex-shrink: 0; overflow: hidden;
  background: var(--paper); border: 1px solid var(--line-strong);
  display: flex; align-items: center; justify-content: center;
}
.bg-preview-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.bg-preview-empty { font-size: 0.66rem; color: var(--ink-faint); text-transform: uppercase; letter-spacing: 0.03em; }
.bg-picker-actions { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; flex: 1; }
.bg-picker-actions .btn-ghost { width: 100%; justify-content: center; }

.panel-title {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.28rem;
  letter-spacing: -0.01em;
  border-bottom: 1px solid var(--line-strong);
  padding-bottom: 12px;
  margin-bottom: 16px;
  position: relative;
}
.panel-title::after {
  content: '';
  position: absolute;
  left: 0; bottom: -1px;
  width: 42px; height: 2px;
  background: var(--c-accent);
}
.panel-title.small { font-size: 1.05rem; color: var(--c-over-text); }
.panel-title.small::after { background: var(--c-over-text); }
.panel-sub { font-family: var(--font-mono); font-size: 0.78rem; font-weight: 500; color: var(--ink-faint); }

.hero-row {
  display: flex;
  align-items: center;
  gap: 20px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 18px;
  margin-bottom: 16px;
}
.ring-wrap { position: relative; flex-shrink: 0; }
.ring-track { stroke: rgba(245,239,221,0.08); }
.ring-tick { stroke: var(--ink-faint); stroke-width: 1.5; opacity: 0.5; }
.ring-fill { transition: stroke-dashoffset 0.8s cubic-bezier(.4,0,.2,1); animation: ringIn 0.8s cubic-bezier(.4,0,.2,1); }
.ring-center {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
}
.ring-value { font-family: var(--font-mono); font-weight: 600; font-size: 1.65rem; line-height: 1; color: var(--ink); }
.ring-goal { font-size: 0.66rem; color: var(--ink-faint); margin-top: 5px; text-transform: uppercase; letter-spacing: 0.04em; }
.ring-pct-chip {
  position: absolute; left: 50%; bottom: -4px; transform: translateX(-50%);
  background: var(--paper-2); border: 1px solid var(--line-strong); border-radius: 999px;
  padding: 3px 10px; font-family: var(--font-mono); font-size: 0.7rem; font-weight: 600; color: var(--c-accent);
}
.ring-pct-chip.over { color: var(--c-over-text); }
@keyframes ringIn { from { opacity: 0; } to { opacity: 1; } }

.hero-stats { display: flex; flex-direction: column; gap: 10px; flex: 1; min-width: 0; }
.hero-stat { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
.hero-stat:last-child { border-bottom: none; padding-bottom: 0; }
.hero-stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-dim); font-weight: 600; }
.hero-stat-value { font-family: var(--font-mono); font-weight: 600; font-size: 0.72rem; }
.hero-stat.net .hero-stat-value { color: var(--c-accent); }

.steps-row { border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 16px; }
.steps-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.row-label { font-family: var(--font-body); font-weight: 600; text-transform: uppercase; font-size: 0.75rem; letter-spacing: 0.03em; color: var(--ink-dim); display: flex; align-items: center; gap: 6px; }
.row-icon { flex-shrink: 0; }
.steps-input {
  width: 92px; text-align: right; font-family: var(--font-mono); font-size: 0.92rem;
  border: 1px solid var(--line-strong); border-radius: 8px; background: var(--paper); padding: 6px 9px; color: var(--ink);
}
.steps-input:focus { outline: none; border-color: var(--c-accent); }
.steps-burn { font-size: 0.74rem; color: var(--ink-faint); margin-top: 7px; font-family: var(--font-mono); }

.bar-track { height: 8px; border-radius: 6px; background: rgba(0,0,0,0.25); border: 1px solid var(--line); position: relative; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 6px; transition: width 0.4s ease; }

.nutrient-list { display: flex; flex-direction: column; }
.nutrient-row { padding: 10px 0; border-bottom: 1px solid var(--line); }
.nutrient-row:last-child { border-bottom: none; padding-bottom: 0; }
.row-top { display: flex; justify-content: space-between; margin-bottom: 6px; }
.row-value { font-family: var(--font-mono); font-size: 0.85rem; font-weight: 600; }
.row-goal { color: var(--ink-faint); font-weight: 500; }
.row-remaining { font-size: 0.7rem; color: var(--ink-faint); margin-top: 5px; font-family: var(--font-mono); }
.row-remaining.over { color: var(--c-over-text); }

.food-panel { padding-top: 18px; }
.section-label {
  font-family: var(--font-display); font-weight: 700;
  letter-spacing: -0.005em; font-size: 1.02rem; margin-bottom: 4px; color: var(--ink);
}
.empty-note { font-size: 0.85rem; color: var(--ink-faint); padding: 10px 0; }

.empty-state {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 8px; padding: 28px 10px;
}
.empty-state-icon {
  width: 46px; height: 46px; border-radius: 50%; background: var(--paper);
  border: 1px solid var(--line-strong); color: var(--ink-faint);
  display: flex; align-items: center; justify-content: center;
}
.empty-state-title { font-family: var(--font-display); font-weight: 700; font-size: 1rem; color: var(--ink); }
.empty-state-sub { font-size: 0.8rem; color: var(--ink-faint); max-width: 240px; }

.stagger { animation: fadeInUp 0.35s ease both; }
@keyframes fadeInUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.food-item {
  display: flex; align-items: flex-start; gap: 12px;
  border-bottom: 1px solid var(--line); padding: 12px 0;
  transition: background 0.15s ease;
}
.food-item:hover { background: rgba(245,239,221,0.02); }
.food-item:last-child { border-bottom: none; }
.food-item-tappable { cursor: pointer; }
.food-avatar {
  width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0; margin-top: 1px;
  display: flex; align-items: center; justify-content: center;
}
.food-avatar.meal { background: var(--badge-bg); color: var(--c-accent); }
.food-avatar.burn { background: var(--badge-bg); color: var(--c-over-text); }
.food-item-main { flex: 1; min-width: 0; }
.food-item-top { display: flex; justify-content: space-between; gap: 10px; font-weight: 600; }
.food-name { font-size: 0.92rem; }
.food-kcal { font-family: var(--font-mono); font-size: 0.85rem; white-space: nowrap; }
.food-item-sub { font-family: var(--font-mono); font-size: 0.72rem; color: var(--ink-faint); margin-top: 4px; }

.icon-btn {
  background: none; border: none; color: var(--ink-dim); cursor: pointer;
  padding: 6px; display: flex; align-items: center; justify-content: center; border-radius: 8px;
  transition: color 0.15s ease, background 0.15s ease;
}
.icon-btn:hover { color: var(--c-over-text); background: var(--c-over-soft); }
.icon-btn:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }

.field { display: flex; flex-direction: column; gap: 5px; font-size: 0.8rem; margin-bottom: 12px; }
.field span { font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; font-size: 0.7rem; color: var(--ink-dim); }
.field input, .field-select {
  border: 1px solid var(--line-strong); border-radius: 10px; background: var(--paper); padding: 10px 12px;
  font-family: var(--font-mono); font-size: 0.92rem; color: var(--ink); width: 100%;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.field input:focus, .field-select:focus { outline: none; border-color: var(--c-accent); box-shadow: 0 0 0 3px var(--c-accent-soft); }
.field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.field-grid .field:first-child { grid-column: 1 / -1; }

.hint-text { font-size: 0.75rem; color: var(--ink-faint); margin-top: 2px; margin-bottom: 8px; }

.model-tag { font-family: var(--font-mono); font-size: 0.7rem; color: var(--ink-faint); margin: -4px 0 16px; }
.model-chip {
  display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  background: var(--badge-bg); color: var(--c-accent); font-size: 0.62rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.02em; vertical-align: middle;
}

.modal-backdrop {
  position: fixed; top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(10, 16, 12, 0.55); backdrop-filter: blur(3px);
  display: flex; align-items: flex-end; justify-content: center; z-index: 100;
  animation: fadein 0.2s ease;
}
.modal {
  background:
    radial-gradient(circle at 50% -15%, rgba(0,230,195,0.18), transparent 55%),
    radial-gradient(circle at 50% 100%, rgba(51,73,93,0.72) 0%, rgba(30,44,58,0.78) 100%);
  backdrop-filter: blur(28px);
  -webkit-backdrop-filter: blur(28px);
  width: 100%; max-width: 480px;
  border-top: 1px solid rgba(255,255,255,0.09);
  border-radius: 26px 26px 0 0;
  padding: 22px 22px 26px;
  max-height: 90vh; overflow-y: auto;
  box-shadow: 0 -20px 50px -20px rgba(0,0,0,0.5);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
.modal-title { font-family: var(--font-display); font-weight: 700; font-size: 1.25rem; }

.type-toggle { display: flex; gap: 4px; margin-bottom: 20px; background: var(--paper); padding: 5px; border-radius: 999px; border: 1px solid var(--line); }
.type-toggle button { flex: 1; justify-content: center; border-radius: 999px; }
.type-toggle .btn-ghost, .type-toggle .btn-primary { border: none; }

.choose-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.choose-card {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  background: var(--paper); border: 1px solid var(--line); border-radius: 16px; padding: 20px 10px;
  color: var(--ink); cursor: pointer; text-align: center; transition: all 0.15s ease;
}
.choose-card:hover:not(:disabled) { border-color: var(--c-accent); background: var(--paper-3); transform: translateY(-2px); }
.choose-card-icon {
  width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  background: var(--badge-bg); color: var(--c-accent);
}
.choose-card span { font-family: var(--font-body); font-weight: 600; font-size: 0.9rem; }
.choose-card small { font-size: 0.74rem; color: var(--ink-faint); }

.analyzing { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 44px 0; color: var(--ink-dim); }
.inline-error { background: var(--c-over-soft); color: var(--c-over-text); padding: 12px 14px; font-size: 0.85rem; margin-bottom: 16px; border-radius: 10px; border-left: 3px solid var(--c-over); }
.inline-note { background: var(--c-accent-soft); color: var(--c-accent); padding: 12px 14px; font-size: 0.85rem; margin-bottom: 16px; border-radius: 10px; border-left: 3px solid var(--c-accent); }
.confirm-row { padding: 14px; border-radius: 12px; border: 1px solid rgba(226,105,75,0.4); font-size: 0.85rem; }
  
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.btn-primary, .btn-ghost, .btn-danger {
  font-family: var(--font-body); font-weight: 600; font-size: 0.84rem; padding: 10px 18px;
  border: 1px solid var(--line-strong); border-radius: 999px; cursor: pointer;
  display: flex; align-items: center; gap: 6px; transition: all 0.15s ease;
}
.btn-primary { background: var(--c-accent); border-color: var(--c-accent); color: #04201C; }
.btn-primary:hover:not(:disabled) { filter: brightness(1.08); }
.btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-ghost { background: transparent; color: var(--ink); }
.btn-ghost:hover { background: var(--paper-3); }
.btn-danger { background: var(--c-over-soft); border-color: #f3eeec; color: #f3eeec; }
.btn-danger:hover { filter: brightness(1.08); }

.bottom-nav {
  position: fixed; bottom: calc(14px + env(safe-area-inset-bottom, 14px)); left: 50%; transform: translateX(-50%);
  width: calc(100% - 28px); max-width: 100%
  background: radial-gradient(circle at 30% 0%, rgba(51,73,93,0.65) 0%, rgba(34,51,73,0.7) 100%);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09);
  border-radius: 26px;
  display: flex; justify-content: space-around; align-items: center;
  padding: 10px 12px; z-index: 50;
  box-shadow: var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.06);
}
.nav-btn {
  position: relative;
  background: none; border: none; color: var(--ink-faint);
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  font-family: var(--font-body); font-size: 0.66rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.02em;
  cursor: pointer; padding: 6px 8px; border-radius: 14px; transition: color 0.15s ease;
}
.nav-btn.active { color: var(--ink); }
.nav-dot {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%) scale(0);
  width: 4px; height: 4px; border-radius: 50%; background: var(--c-accent);
  transition: transform 0.2s ease;
}
.nav-btn.active .nav-dot { transform: translateX(-50%) scale(1); }
.fab {
  background: linear-gradient(135deg, var(--c-accent), var(--c-over)); color: #04201C; border: 3px solid var(--paper-2);
  border-radius: 50%; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: transform 0.15s ease;
}
.fab:active { transform: scale(0.93); }
.btn-primary:active, .btn-ghost:active, .btn-danger:active, .choose-card:active:not(:disabled) { transform: scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  .stagger, .ring-fill, .app-main, .modal-backdrop, .toast, .aurora-orb { animation: none !important; }
  .ring-fill, .bar-fill, .sparkline-bar, .history-ratio-fill, .food-item, .fab, .btn-primary, .btn-ghost, .btn-danger, .choose-card, .nav-dot {
    transition: none !important;
  }
}

.sparkline { display: flex; justify-content: space-between; align-items: flex-end; gap: 8px; height: 84px; }
.sparkline-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; height: 100%; }
.sparkline-track { flex: 1; width: 100%; display: flex; align-items: flex-end; }
.sparkline-bar {
  width: 100%; border-radius: 5px 5px 2px 2px; background: var(--c-good);
  transition: height 0.4s ease; min-height: 2px;
}
.sparkline-bar.over { background: var(--c-over); }
.sparkline-bar.current { background: var(--c-accent); }
.sparkline-label { font-family: var(--font-mono); font-size: 0.66rem; color: var(--ink-faint); text-transform: uppercase; }
.sparkline-label.current { color: var(--c-accent); font-weight: 600; }

.history-ratio-track { height: 4px; border-radius: 4px; background: rgba(0,0,0,0.25); margin-top: 8px; overflow: hidden; }
.history-ratio-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }

.history-row { border-bottom: 1px solid var(--line); }
.history-row:last-child { border-bottom: none; }
.history-summary {
  width: 100%; display: flex; justify-content: space-between; align-items: center;
  background: none; border: none; padding: 13px 0; text-align: left; color: var(--ink); cursor: pointer;
}
.history-date { font-weight: 600; font-size: 0.95rem; margin-bottom: 3px; }
.history-sub { font-family: var(--font-mono); font-size: 0.74rem; color: var(--ink-faint); }
.history-detail { padding: 0 0 14px 12px; border-left: 2px solid var(--line-strong); margin-left: 6px; }
.history-food { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; padding: 5px 0; font-family: var(--font-mono); cursor: pointer; }
.history-steps-row { display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 6px; border-bottom: 1px solid var(--line); }

.toast {
  position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
  background: var(--ink); color: var(--paper); padding: 11px 22px;
  font-family: var(--font-body); font-weight: 600; font-size: 0.88rem;
  z-index: 200; box-shadow: 0 14px 34px -12px rgba(0,0,0,0.55); border-radius: 999px;
  animation: fadein 0.2s ease, fadeout 0.2s ease 2s forwards;
}
@keyframes fadeout { to { opacity: 0; visibility: hidden; } }
`;
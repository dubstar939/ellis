/**
 * @fileoverview Control real time music with text prompts
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {css, CSSResultGroup, html, LitElement, svg, PropertyValues} from 'lit';
import {customElement, property, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {styleMap} from 'lit/directives/style-map.js';
import {repeat} from 'lit/directives/repeat.js';

import { GoogleGenAI, type LiveMusicGenerationConfig, type LiveMusicServerMessage, type LiveMusicSession } from '@google/genai';
import {decode, decodeAudioData} from './utils';

const getApiKey = () => {
  try {
    return process.env.API_KEY || process.env.GEMINI_API_KEY || '';
  } catch (e) {
    return '';
  }
};

const ai = new GoogleGenAI({
  apiKey: getApiKey(),
  apiVersion: 'v1alpha',
});
let model = 'lyria-realtime-exp';

interface Prompt {
  readonly promptId: string;
  readonly color: string;
  text: string;
  weight: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/** Throttles a callback to be called at most once per `freq` milliseconds. */
function throttle(func: (...args: unknown[]) => void, delay: number) {
  let lastCall = 0;
  return (...args: unknown[]) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      func(...args);
      lastCall = now;
    }
  };
}

function encodeVarInt(num: number): number[] {
  const bytes: number[] = [];
  let value = num;
  while (value > 0) {
    let byteVal = value & 0x7F;
    value >>>= 7;
    if (bytes.length > 0) {
      byteVal |= 0x80;
    }
    bytes.unshift(byteVal);
  }
  if (bytes.length === 0) {
    bytes.push(0);
  }
  return bytes;
}

const PRESET_CATEGORIES: Record<'Genres' | 'Instruments' | 'Effects & Feel', { name: string, defaultVolume: number }[]> = {
  'Genres': [
    { name: 'Bossa Nova', defaultVolume: 0.75 }, { name: 'Minimal Techno', defaultVolume: 0.8 },
    { name: 'Drum and Bass', defaultVolume: 0.85 }, { name: 'Post Punk', defaultVolume: 0.7 },
    { name: 'Shoegaze', defaultVolume: 0.65 }, { name: 'Funk', defaultVolume: 0.75 },
    { name: 'Chiptune', defaultVolume: 0.7 }, { name: 'Dubstep', defaultVolume: 0.85 },
    { name: 'K Pop', defaultVolume: 0.8 }, { name: 'Neo Soul', defaultVolume: 0.7 },
    { name: 'Trip Hop', defaultVolume: 0.75 }, { name: 'Thrash', defaultVolume: 0.9 },
    { name: 'Electronic', defaultVolume: 0.8 }, { name: 'Ambient', defaultVolume: 0.5 },
    { name: 'Industrial', defaultVolume: 0.8 }, { name: 'Lo-fi', defaultVolume: 0.6 }
  ],
  'Instruments': [
    { name: 'Lush Strings', defaultVolume: 0.6 }, { name: 'Sparkling Arpeggios', defaultVolume: 0.7 },
    { name: 'Staccato Rhythms', defaultVolume: 0.75 }, { name: 'Punchy Kick', defaultVolume: 0.9 },
    { name: 'Rhythm', defaultVolume: 0.8 }, { name: 'Melody', defaultVolume: 0.8 },
    { name: 'Harmony', defaultVolume: 0.7 }, { name: 'Analog Synth', defaultVolume: 0.75 },
    { name: 'Digital Lead', defaultVolume: 0.75 }, { name: 'Resonant Bass', defaultVolume: 0.85 },
    { name: 'Acoustic Piano', defaultVolume: 0.65 }, { name: 'Sub Bass', defaultVolume: 0.9 }
  ],
  'Effects & Feel': [
    { name: 'Reverb', defaultVolume: 0.5 }, { name: 'Delay', defaultVolume: 0.5 },
    { name: 'Distortion', defaultVolume: 0.6 }, { name: 'Filter', defaultVolume: 0.55 },
    { name: 'Resonance', defaultVolume: 0.6 }, { name: 'Cutoff', defaultVolume: 0.65 },
    { name: 'Decay', defaultVolume: 0.5 }, { name: 'Sustain', defaultVolume: 0.55 },
    { name: 'Release', defaultVolume: 0.5 }, { name: 'Attack', defaultVolume: 0.5 },
    { name: 'Legato', defaultVolume: 0.55 }, { name: 'Vibrato', defaultVolume: 0.45 },
    { name: 'Glissando', defaultVolume: 0.5 }, { name: 'Cinematic', defaultVolume: 0.7 },
    { name: 'Aggressive', defaultVolume: 0.8 }, { name: 'Soothing', defaultVolume: 0.5 },
    { name: 'Experimental', defaultVolume: 0.65 }, { name: 'High Fidelity', defaultVolume: 0.7 }
  ]
};

const MUSICAL_TERMS = [
  ...PRESET_CATEGORIES['Genres'].map(g => g.name),
  ...PRESET_CATEGORIES['Instruments'].map(i => i.name),
  ...PRESET_CATEGORIES['Effects & Feel'].map(e => e.name)
];

interface SessionData {
  id: string;
  name: string;
  prompts: Prompt[];
  settings: LiveMusicGenerationConfig;
  createdAt: number;
}

const COLORS = [
  '#9900ff',
  '#5200ff',
  '#ff25f6',
  '#2af6de',
  '#ffdd28',
  '#3dffab',
  '#d8ff3e',
  '#d9b2ff',
];

function getUnusedRandomColor(usedColors: string[]): string {
  const availableColors = COLORS.filter((c) => !usedColors.includes(c));
  if (availableColors.length === 0) {
    // If no available colors, pick a random one from the original list.
    return COLORS[Math.floor(Math.random() * COLORS.length)];
  }
  return availableColors[Math.floor(Math.random() * availableColors.length)];
}

// WeightSlider component
// -----------------------------------------------------------------------------
/** A slider for adjusting and visualizing prompt weight. */
@customElement('weight-slider')
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      cursor: ns-resize;
      position: relative;
      height: 100%;
      display: flex;
      justify-content: center;
      flex-direction: column;
      align-items: center;
      padding: 5px;
    }
    .scroll-container {
      width: 100%;
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    .value-display {
      font-size: 1.3vmin;
      color: #ccc;
      margin: 0.5vmin 0;
      user-select: none;
      text-align: center;
    }
    .slider-container {
      position: relative;
      width: 10px;
      height: 100%;
      background-color: #0009;
      border-radius: 4px;
    }
    #thumb {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      border-radius: 4px;
      box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
    }
  `;

  @property({type: Number}) value = 0; // Range 0-2
  @property({type: String}) color = '#000';

  @query('.scroll-container') private scrollContainer!: HTMLDivElement;

  private dragStartPos = 0;
  private dragStartValue = 0;
  private containerBounds: DOMRect | null = null;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handleTouchMove = this.handleTouchMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    e.preventDefault();
    this.containerBounds = this.scrollContainer.getBoundingClientRect();
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('touchmove', this.handleTouchMove, {
      passive: false,
    });
    window.addEventListener('pointerup', this.handlePointerUp, {once: true});
    this.updateValueFromPosition(e.clientY);
  }

  private handlePointerMove(e: PointerEvent) {
    this.updateValueFromPosition(e.clientY);
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault();
    this.updateValueFromPosition(e.touches[0].clientY);
  }

  private handlePointerUp(e: PointerEvent) {
    window.removeEventListener('pointermove', this.handlePointerMove);
    document.body.classList.remove('dragging');
    this.containerBounds = null;
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    this.value = this.value + delta * -0.005;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchInputEvent();
  }

  private updateValueFromPosition(clientY: number) {
    if (!this.containerBounds) return;

    const trackHeight = this.containerBounds.height;
    // Calculate position relative to the top of the track
    const relativeY = clientY - this.containerBounds.top;
    // Invert and normalize (0 at bottom, 1 at top)
    const normalizedValue =
      1 - Math.max(0, Math.min(trackHeight, relativeY)) / trackHeight;
    // Scale to 0-2 range
    this.value = normalizedValue * 2;

    this.dispatchInputEvent();
  }

  private dispatchInputEvent() {
    this.dispatchEvent(new CustomEvent<number>('input', {detail: this.value}));
  }

  override render() {
    const thumbHeightPercent = (this.value / 2) * 100;
    const thumbStyle = styleMap({
      height: `${thumbHeightPercent}%`,
      backgroundColor: this.color,
      // Hide thumb if value is 0 or very close to prevent visual glitch
      display: this.value > 0.01 ? 'block' : 'none',
    });
    const displayValue = this.value.toFixed(2);

    return html`
      <div
        class="scroll-container"
        @pointerdown=${this.handlePointerDown}
        @wheel=${this.handleWheel}>
        <div class="slider-container">
          <div id="thumb" style=${thumbStyle}></div>
        </div>
        <div class="value-display">${displayValue}</div>
      </div>
    `;
  }
}

// Base class for icon buttons.
class IconButton extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    :host(:hover) svg {
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
      transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 9%;
      border-radius: 50%;
      cursor: pointer;
    }
  ` as CSSResultGroup;

  // Method to be implemented by subclasses to provide the specific icon SVG
  protected renderIcon() {
    return svg``; // Default empty icon
  }

  private renderSVG() {
    return html` <svg
      width="140"
      height="140"
      viewBox="0 -10 140 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg">
      <rect
        x="22"
        y="6"
        width="96"
        height="96"
        rx="48"
        fill="black"
        fill-opacity="0.05" />
      <rect
        x="23.5"
        y="7.5"
        width="93"
        height="93"
        rx="46.5"
        stroke="black"
        stroke-opacity="0.3"
        stroke-width="3" />
      <g filter="url(#filter0_ddi_1048_7373)">
        <rect
          x="25"
          y="9"
          width="90"
          height="90"
          rx="45"
          fill="white"
          fill-opacity="0.05"
          shape-rendering="crispEdges" />
      </g>
      ${this.renderIcon()}
      <defs>
        <filter
          id="filter0_ddi_1048_7373"
          x="0"
          y="0"
          width="140"
          height="140"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="4" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_1048_7373" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="16" />
          <feGaussianBlur stdDeviation="12.5" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_1048_7373"
            result="effect2_dropShadow_1048_7373" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect2_dropShadow_1048_7373"
            result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1.5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2="shape"
            result="effect3_innerShadow_1048_7373" />
        </filter>
      </defs>
    </svg>`;
  }

  override render() {
    return html`${this.renderSVG()}<div class="hitbox"></div>`;
  }
}

// PlayPauseButton
// -----------------------------------------------------------------------------

/** A button for toggling play/pause. */
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({type: String}) playbackState: PlaybackState = 'stopped';

  static override styles = [
    IconButton.styles,
    css`
      .loader {
        stroke: #ffffff;
        stroke-width: 3;
        stroke-linecap: round;
        animation: spin linear 1s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      @keyframes spin {
        from {
          transform: rotate(0deg);
        }
        to {
          transform: rotate(359deg);
        }
      }
    `,
  ];

  private renderPause() {
    return svg`<path
      d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z"
      fill="#FEFEFE"
    />`;
  }

  private renderPlay() {
    return svg`<path d="M60 71.5V36.5L87.5 54L60 71.5Z" fill="#FEFEFE" />`;
  }

  private renderLoading() {
    return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5
            l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`;
  }

  override renderIcon() {
    if (this.playbackState === 'playing') {
      return this.renderPause();
    } else if (this.playbackState === 'loading') {
      return this.renderLoading();
    } else {
      return this.renderPlay();
    }
  }
}

@customElement('reset-button')
export class ResetButton extends IconButton {
  private renderResetIcon() {
    return svg`<path fill="#fefefe" d="M71,77.1c-2.9,0-5.7-0.6-8.3-1.7s-4.8-2.6-6.7-4.5c-1.9-1.9-3.4-4.1-4.5-6.7c-1.1-2.6-1.7-5.3-1.7-8.3h4.7
      c0,4.6,1.6,8.5,4.8,11.7s7.1,4.8,11.7,4.8c4.6,0,8.5-1.6,11.7-4.8c3.2-3.2,4.8-7.1,4.8-11.7s-1.6-8.5-4.8-11.7
      c-3.2-3.2-7.1-4.8-11.7-4.8h-0.4l3.7,3.7L71,46.4L61.5,37l9.4-9.4l3.3,3.4l-3.7,3.7H71c2.9,0,5.7,0.6,8.3,1.7
      c2.6,1.1,4.8,2.6,6.7,4.5c1.9,1.9,3.4,4.1,4.5,6.7c1.1,2.6,1.7,5.3,1.7,8.3c0,2.9-0.6,5.7-1.7,8.3c-1.1,2.6-2.6,4.8-4.5,6.7
      s-4.1,3.4-6.7,4.5C76.7,76.5,73.9,77.1,71,77.1z"/>`;
  }

  override renderIcon() {
    return this.renderResetIcon();
  }
}

// AddPromptButton component
// -----------------------------------------------------------------------------
/** A button for adding a new prompt. */
@customElement('add-prompt-button')
export class AddPromptButton extends IconButton {
  private renderAddIcon() {
    return svg`<path d="M67 40 H73 V52 H85 V58 H73 V70 H67 V58 H55 V52 H67 Z" fill="#FEFEFE" />`;
  }

  override renderIcon() {
    return this.renderAddIcon();
  }
}

// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #000;
      color: white;
      padding: 15px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 200px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 11;
    }
    button {
      border-radius: 100px;
      aspect-ratio: 1;
      border: none;
      color: #000;
      cursor: pointer;
    }
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({type: String}) message = '';
  @property({type: Boolean}) showing = false;

  override render() {
    return html`<div class=${classMap({showing: this.showing, toast: true})}>
      <div class="message">${this.message}</div>
      <button @click=${this.hide}>✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
  }
}

/** A single prompt input */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt {
      position: relative;
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      box-sizing: border-box;
      overflow: hidden;
      background-color: #2a2a2a;
      border-radius: 5px;
    }
    .remove-button {
      position: absolute;
      top: 1.2vmin;
      left: 1.2vmin;
      background: #666;
      color: #fff;
      border: none;
      border-radius: 50%;
      width: 2.8vmin;
      height: 2.8vmin;
      font-size: 1.8vmin;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 2.8vmin;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 0.2s;
      z-index: 10;
    }
    .remove-button:hover {
      opacity: 1;
    }
    weight-slider {
      /* Calculate height: 100% of parent minus controls height and margin */
      max-height: calc(100% - 9vmin);
      flex: 1;
      min-height: 10vmin;
      width: 100%;
      box-sizing: border-box;
      overflow: hidden;
      margin: 2vmin 0 1vmin;
    }
    .controls {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      align-items: center;
      gap: 0.2vmin;
      width: 100%;
      height: 8vmin;
      padding: 0 0.5vmin;
      box-sizing: border-box;
      margin-bottom: 1vmin;
    }
    #text {
      font-family: 'Google Sans', sans-serif;
      font-size: 1.8vmin;
      width: 100%;
      flex-grow: 1;
      max-height: 100%;
      padding: 0.4vmin;
      box-sizing: border-box;
      text-align: center;
      word-wrap: break-word;
      overflow-y: auto;
      border: none;
      outline: none;
      -webkit-font-smoothing: antialiased;
      color: #fff;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
    }
    #text::-webkit-scrollbar {
      width: 6px;
    }
    #text::-webkit-scrollbar-track {
      background: #0009;
      border-radius: 3px;
    }
    #text::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 3px;
    }
    .suggestions {
      position: absolute;
      bottom: 100%;
      left: 0;
      width: 100%;
      background: #333;
      border: 1px solid #5200ff;
      border-radius: 4px;
      max-height: 15vmin;
      overflow-y: auto;
      z-index: 20;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.5);
    }
    .suggestion-item {
      padding: 0.8vmin;
      cursor: pointer;
      font-size: 1.4vmin;
      color: #eee;
    }
    .suggestion-item:hover {
      background: #5200ff;
    }
    .formatting-toolbar {
      display: flex;
      gap: 1vmin;
      margin-bottom: 0.5vmin;
      padding: 0 0.5vmin;
    }
    .format-btn {
      background: #444;
      border: none;
      color: white;
      padding: 0.2vmin 0.6vmin;
      cursor: pointer;
      font-size: 1.2vmin;
      border-radius: 2px;
    }
    .format-btn:hover {
      background: #666;
    }
    :host([filtered='true']) #text {
      background: #da2000;
    }
  `;

  @property({type: String, reflect: true}) promptId = '';
  @property({type: String}) text = '';
  @property({type: Number}) weight = 0;
  @property({type: String}) color = '';

  @query('weight-slider') private weightInput!: WeightSlider;
  @query('#text') private textInput!: HTMLDivElement;

  @state() private suggestions: string[] = [];
  @state() private showSuggestions = false;

  private handleTextKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.updateText();
      (e.target as HTMLElement).blur();
      this.showSuggestions = false;
    }
  }

  private handleTextInput(e: InputEvent) {
    const text = this.textInput.innerText;
    const words = text.split(/\s+/);
    const lastWord = words[words.length - 1];

    if (lastWord.length >= 2) {
      this.suggestions = MUSICAL_TERMS.filter(term =>
        term.toLowerCase().startsWith(lastWord.toLowerCase()) &&
        term.toLowerCase() !== lastWord.toLowerCase()
      ).slice(0, 5);
      this.showSuggestions = this.suggestions.length > 0;
    } else {
      this.showSuggestions = false;
    }
  }

  private applySuggestion(term: string) {
    const text = this.textInput.innerText;
    const words = text.split(/\s+/);
    words[words.length - 1] = term;
    this.textInput.innerText = words.join(' ') + ' ';
    this.showSuggestions = false;
    this.updateText();
    this.textInput.focus();
    // Move cursor to end
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(this.textInput);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  private execCommand(command: string) {
    document.execCommand(command, false);
    this.updateText();
  }

  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: {
          promptId: this.promptId,
          text: this.text,
          weight: this.weight,
          color: this.color,
        },
      }),
    );
  }

  private updateText() {
    console.log('updateText');
    const newText = this.textInput.textContent?.trim();
    if (newText === '') {
      this.textInput.textContent = this.text;
      return;
    }
    this.text = newText;
    this.dispatchPromptChange();
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }

  private dispatchPromptRemoved() {
    this.dispatchEvent(
      new CustomEvent<string>('prompt-removed', {
        detail: this.promptId,
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render() {
    const classes = classMap({
      'prompt': true,
    });
    return html`<div class=${classes}>
      <button class="remove-button" @click=${this.dispatchPromptRemoved}
        >×</button
      >
      ${this.showSuggestions ? html`
        <div class="suggestions">
          ${this.suggestions.map(s => html`
            <div class="suggestion-item" @click=${() => this.applySuggestion(s)}>${s}</div>
          `)}
        </div>
      ` : ''}
      <weight-slider
        id="weight"
        value=${this.weight}
        color=${this.color}
        @input=${this.updateWeight}></weight-slider>
      <div class="controls">
        <div class="formatting-toolbar">
          <button class="format-btn" @click=${() => this.execCommand('bold')}>B</button>
          <button class="format-btn" @click=${() => this.execCommand('italic')}>I</button>
        </div>
        <div
          id="text"
          spellcheck="false"
          contenteditable="true"
          @keydown=${this.handleTextKeyDown}
          @input=${this.handleTextInput}
          @blur=${this.updateText}
          .innerHTML=${this.text}
        ></div>
      </div>
    </div>`;
  }
}

/** A panel for managing real-time music generation settings. */
@customElement('settings-controller')
class SettingsController extends LitElement {
  static override styles = css`
    :host {
      display: block;
      padding: 2vmin;
      background-color: #2a2a2a;
      color: #eee;
      box-sizing: border-box;
      border-radius: 5px;
      font-family: 'Google Sans', sans-serif;
      font-size: 1.5vmin;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
      transition: width 0.3s ease-out max-height 0.3s ease-out;
    }
    :host([showadvanced]) {
      max-height: 40vmin;
    }
    :host::-webkit-scrollbar {
      width: 6px;
    }
    :host::-webkit-scrollbar-track {
      background: #1a1a1a;
      border-radius: 3px;
    }
    :host::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 3px;
    }
    .setting {
      margin-bottom: 0.5vmin;
      display: flex;
      flex-direction: column;
      gap: 0.5vmin;
    }
    label {
      font-weight: bold;
      display: flex;
      justify-content: space-between;
      align-items: center;
      white-space: nowrap;
      user-select: none;
    }
    label span:last-child {
      font-weight: normal;
      color: #ccc;
      min-width: 3em;
      text-align: right;
    }
    input[type='range'] {
      --track-height: 8px;
      --track-bg: #0009;
      --track-border-radius: 4px;
      --thumb-size: 16px;
      --thumb-bg: #5200ff;
      --thumb-border-radius: 50%;
      --thumb-box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
      --value-percent: 0%;
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: var(--track-height);
      background: transparent;
      cursor: pointer;
      margin: 0.5vmin 0;
      border: none;
      padding: 0;
      vertical-align: middle;
    }
    input[type='range']::-webkit-slider-runnable-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      border: none;
      background: linear-gradient(
        to right,
        var(--thumb-bg) var(--value-percent),
        var(--track-bg) var(--value-percent)
      );
      border-radius: var(--track-border-radius);
    }
    input[type='range']::-moz-range-track {
      width: 100%;
      height: var(--track-height);
      cursor: pointer;
      background: var(--track-bg);
      border-radius: var(--track-border-radius);
      border: none;
    }
    input[type='range']::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      margin-top: calc((var(--thumb-size) - var(--track-height)) / -2);
    }
    input[type='range']::-moz-range-thumb {
      height: var(--thumb-size);
      width: var(--thumb-size);
      background: var(--thumb-bg);
      border-radius: var(--thumb-border-radius);
      box-shadow: var(--thumb-box-shadow);
      cursor: pointer;
      border: none;
    }
    input[type='number'],
    input[type='text'],
    select {
      background-color: #2a2a2a;
      color: #eee;
      border: 1px solid #666;
      border-radius: 3px;
      padding: 0.4vmin;
      font-size: 1.5vmin;
      font-family: inherit;
      box-sizing: border-box;
    }
    input[type='number'] {
      width: 6em;
    }
    input[type='text'] {
      width: 100%;
    }
    input[type='text']::placeholder {
      color: #888;
    }
    input[type='number']:focus,
    input[type='text']:focus {
      outline: none;
      border-color: #5200ff;
      box-shadow: 0 0 0 2px rgba(82, 0, 255, 0.3);
    }
    select {
      width: 100%;
    }
    select:focus {
      outline: none;
      border-color: #5200ff;
    }
    select option {
      background-color: #2a2a2a;
      color: #eee;
    }
    .checkbox-setting {
      flex-direction: row;
      align-items: center;
      gap: 1vmin;
    }
    input[type='checkbox'] {
      cursor: pointer;
      accent-color: #5200ff;
    }
    .core-settings-row {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 4vmin;
      margin-bottom: 1vmin;
      justify-content: space-evenly;
    }
    .core-settings-row .setting {
      min-width: 16vmin;
    }
    .core-settings-row label span:last-child {
      min-width: 2.5em;
    }
    .advanced-toggle {
      cursor: pointer;
      margin: 2vmin 0 1vmin 0;
      color: #aaa;
      text-decoration: underline;
      user-select: none;
      font-size: 1.4vmin;
      width: fit-content;
    }
    .advanced-toggle:hover {
      color: #eee;
    }
    .advanced-settings {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(10vmin, 1fr));
      gap: 3vmin;
      overflow: hidden;
      max-height: 0;
      opacity: 0;
      transition:
        max-height 0.3s ease-out,
        opacity 0.3s ease-out;
    }
    .advanced-settings.visible {
      max-width: 120vmin;
      max-height: 40vmin;
      opacity: 1;
    }
    hr.divider {
      display: none;
      border: none;
      border-top: 1px solid #666;
      margin: 2vmin 0;
      width: 100%;
    }
    :host([showadvanced]) hr.divider {
      display: block;
    }
    .auto-row {
      display: flex;
      align-items: center;
      gap: 0.5vmin;
    }
    .setting[auto='true'] input[type='range'] {
      pointer-events: none;
      filter: grayscale(100%);
    }
    .auto-row span {
      margin-left: auto;
    }
    .auto-row label {
      cursor: pointer;
    }
    .auto-row input[type='checkbox'] {
      cursor: pointer;
      margin: 0;
    }
  `;

  private readonly defaultConfig = {
    temperature: 1.1,
    topK: 40,
    guidance: 4.0,
    musicGenerationMode: 'QUALITY' as any,
  };

  @state() private config: LiveMusicGenerationConfig = this.defaultConfig;

  public computeConfig() {
    return this.config;
  }

  @state() showAdvanced = false;

  @state() autoDensity = true;

  @state() lastDefinedDensity: number;

  @state() autoBrightness = true;

  @state() lastDefinedBrightness: number;

  public resetToDefaults() {
    this.config = this.defaultConfig;
    this.autoDensity = true;
    this.lastDefinedDensity = undefined;
    this.autoBrightness = true;
    this.lastDefinedBrightness = undefined;
    this.dispatchSettingsChange();
  }

  private updateSliderBackground(inputEl: HTMLInputElement) {
    if (inputEl.type !== 'range') {
      return;
    }
    const min = Number(inputEl.min) || 0;
    const max = Number(inputEl.max) || 100;
    const value = Number(inputEl.value);
    const percentage = ((value - min) / (max - min)) * 100;
    inputEl.style.setProperty('--value-percent', `${percentage}%`);
  }

  private handleInputChange(e: Event) {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const key = target.id as
      | keyof LiveMusicGenerationConfig
      | 'auto-density'
      | 'auto-brightness';
    let value: string | number | boolean | undefined = target.value;

    if (target.type === 'number' || target.type === 'range') {
      value = target.value === '' ? undefined : Number(target.value);
      // Update slider background if it's a range input before handling the value change.
      if (target.type === 'range') {
        this.updateSliderBackground(target as HTMLInputElement);
      }
    } else if (target.type === 'checkbox') {
      value = (target as HTMLInputElement).checked;
    } else if (target.type === 'select-one') {
      const selectElement = target as HTMLSelectElement;
      if (selectElement.options[selectElement.selectedIndex]?.disabled) {
        value = undefined;
      } else {
        value = target.value;
      }
    }

    const newConfig = {
      ...this.config,
      [key]: value,
    };

    if (newConfig.density !== undefined) {
      this.lastDefinedDensity = newConfig.density;
      console.log(this.lastDefinedDensity);
    }

    if (newConfig.brightness !== undefined) {
      this.lastDefinedBrightness = newConfig.brightness;
    }

    if (key === 'auto-density') {
      this.autoDensity = Boolean(value);
      newConfig.density = this.autoDensity
        ? undefined
        : this.lastDefinedDensity;
    } else if (key === 'auto-brightness') {
      this.autoBrightness = Boolean(value);
      newConfig.brightness = this.autoBrightness
        ? undefined
        : this.lastDefinedBrightness;
    }

    this.config = newConfig;
    this.dispatchSettingsChange();
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has('config')) {
      this.shadowRoot
        ?.querySelectorAll<HTMLInputElement>('input[type="range"]')
        .forEach((slider: HTMLInputElement) => {
          const configValue =
            this.config[slider.id as keyof LiveMusicGenerationConfig];
          if (typeof configValue === 'number') {
            slider.value = String(configValue);
          } else if (slider.id === 'density' || slider.id === 'brightness') {
            // Handle potentially undefined density/brightness with default for background
            slider.value = String(configValue ?? 0.5);
          }
          this.updateSliderBackground(slider);
        });
    }
  }

  private dispatchSettingsChange() {
    this.dispatchEvent(
      new CustomEvent<LiveMusicGenerationConfig>('settings-changed', {
        detail: this.config,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleAdvancedSettings() {
    this.showAdvanced = !this.showAdvanced;
  }

  override render() {
    const cfg = this.config;
    const advancedClasses = classMap({
      'advanced-settings': true,
      'visible': this.showAdvanced,
    });
    const musicGenerationModeMap = new Map<string, string>([
      ['Quality', 'QUALITY'],
      ['Diversity', 'DIVERSITY'],
      ['Vocalization', 'VOCALIZATION'],
    ]);
    const scaleMap = new Map<string, string>([
      ['Auto', 'SCALE_UNSPECIFIED'],
      ['C Major / A Minor', 'C_MAJOR_A_MINOR'],
      ['C# Major / A# Minor', 'D_FLAT_MAJOR_B_FLAT_MINOR'],
      ['D Major / B Minor', 'D_MAJOR_B_MINOR'],
      ['D# Major / C Minor', 'E_FLAT_MAJOR_C_MINOR'],
      ['E Major / C# Minor', 'E_MAJOR_D_FLAT_MINOR'],
      ['F Major / D Minor', 'F_MAJOR_D_MINOR'],
      ['F# Major / D# Minor', 'G_FLAT_MAJOR_E_FLAT_MINOR'],
      ['G Major / E Minor', 'G_MAJOR_E_MINOR'],
      ['G# Major / F Minor', 'A_FLAT_MAJOR_F_MINOR'],
      ['A Major / F# Minor', 'A_MAJOR_G_FLAT_MINOR'],
      ['A# Major / G Minor', 'B_FLAT_MAJOR_G_MINOR'],
      ['B Major / G# Minor', 'B_MAJOR_A_FLAT_MINOR'],
    ]);

    return html`
      <div class="core-settings-row">
        <div class="setting">
          <label for="temperature"
            >Temperature<span>${cfg.temperature!.toFixed(1)}</span></label
          >
          <input
            type="range"
            id="temperature"
            min="0"
            max="3"
            step="0.1"
            .value=${cfg.temperature!.toString()}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="guidance"
            >Guidance<span>${cfg.guidance!.toFixed(1)}</span></label
          >
          <input
            type="range"
            id="guidance"
            min="0"
            max="6"
            step="0.1"
            .value=${cfg.guidance!.toString()}
            @input=${this.handleInputChange} />
        </div>
        <div class="setting">
          <label for="topK">Top K<span>${cfg.topK}</span></label>
          <input
            type="range"
            id="topK"
            min="1"
            max="100"
            step="1"
            .value=${cfg.topK!.toString()}
            @input=${this.handleInputChange} />
        </div>
      </div>
      <hr class="divider" />
      <div class=${advancedClasses}>
        <div class="setting">
          <label for="seed">Seed</label>
          <input
            type="number"
            id="seed"
            .value=${cfg.seed ?? ''}
            @input=${this.handleInputChange}
            placeholder="Auto" />
        </div>
        <div class="setting">
          <label for="bpm">BPM</label>
          <input
            type="number"
            id="bpm"
            min="60"
            max="180"
            .value=${cfg.bpm ?? ''}
            @input=${this.handleInputChange}
            placeholder="Auto" />
        </div>
        <div class="setting" auto=${this.autoDensity}>
          <label for="density">Density</label>
          <input
            type="range"
            id="density"
            min="0"
            max="1"
            step="0.05"
            .value=${this.lastDefinedDensity}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-density"
              .checked=${this.autoDensity}
              @input=${this.handleInputChange} />
            <label for="auto-density">Auto</label>
            <span>${(this.lastDefinedDensity ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting" auto=${this.autoBrightness}>
          <label for="brightness">Brightness</label>
          <input
            type="range"
            id="brightness"
            min="0"
            max="1"
            step="0.05"
            .value=${this.lastDefinedBrightness}
            @input=${this.handleInputChange} />
          <div class="auto-row">
            <input
              type="checkbox"
              id="auto-brightness"
              .checked=${this.autoBrightness}
              @input=${this.handleInputChange} />
            <label for="auto-brightness">Auto</label>
            <span>${(this.lastDefinedBrightness ?? 0.5).toFixed(2)}</span>
          </div>
        </div>
        <div class="setting">
          <label for="scale">Scale</label>
          <select
            id="scale"
            .value=${cfg.scale || 'SCALE_UNSPECIFIED'}
            @change=${this.handleInputChange}>
            <option value="" disabled selected>Select Scale</option>
            ${[...scaleMap.entries()].map(
              ([displayName, enumValue]) =>
                html`<option value=${enumValue}>${displayName}</option>`,
            )}
          </select>
        </div>
        <div class="setting">
          <label for="musicGenerationMode">Music generation mode</label>
          <select
            id="musicGenerationMode"
            .value=${cfg.musicGenerationMode || 'QUALITY'}
            @change=${this.handleInputChange}>
            ${[...musicGenerationModeMap.entries()].map(
              ([displayName, enumValue]) =>
                html`<option value=${enumValue}>${displayName}</option>`,
            )}
          </select>
        </div>
        <div class="setting">
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteBass"
              .checked=${!!cfg.muteBass}
              @change=${this.handleInputChange} />
            <label for="muteBass" style="font-weight: normal;">Mute Bass</label>
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="muteDrums"
              .checked=${!!cfg.muteDrums}
              @change=${this.handleInputChange} />
            <label for="muteDrums" style="font-weight: normal;"
              >Mute Drums</label
            >
          </div>
          <div class="setting checkbox-setting">
            <input
              type="checkbox"
              id="onlyBassAndDrums"
              .checked=${!!cfg.onlyBassAndDrums}
              @change=${this.handleInputChange} />
            <label for="onlyBassAndDrums" style="font-weight: normal;"
              >Only Bass & Drums</label
            >
          </div>
        </div>
      </div>
      <div class="advanced-toggle" @click=${this.toggleAdvancedSettings}>
        ${this.showAdvanced ? 'Hide' : 'Show'} Advanced Settings
      </div>
    `;
  }
}

/** Component for the PromptDJ UI. */
@customElement('prompt-dj')
class PromptDj extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      padding: 2vmin;
      position: relative;
      font-size: 1.8vmin;
    }
    #background {
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: #111;
    }
    .prompts-area {
      display: flex;
      align-items: flex-end;
      justify-content: center;
      flex: 4;
      width: 100%;
      margin-top: 2vmin;
      gap: 2vmin;
    }
    #prompts-container {
      display: flex;
      flex-direction: row;
      align-items: flex-end;
      flex-shrink: 1;
      height: 100%;
      gap: 2vmin;
      margin-left: 10vmin;
      padding: 1vmin;
      overflow-x: auto;
      scrollbar-width: thin;
      scrollbar-color: #666 #1a1a1a;
    }
    #prompts-container::-webkit-scrollbar {
      height: 8px;
    }
    #prompts-container::-webkit-scrollbar-track {
      background: #111;
      border-radius: 4px;
    }
    #prompts-container::-webkit-scrollbar-thumb {
      background-color: #666;
      border-radius: 4px;
    }
    #prompts-container::-webkit-scrollbar-thumb:hover {
      background-color: #777;
    }
    .viz-container {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
      opacity: 0.55;
    }
    #visualizer {
      width: 100%;
      height: 100%;
    }
    .viz-menu {
      position: absolute;
      bottom: 2vmin;
      right: 2vmin;
      display: flex;
      gap: 1vmin;
      background: rgba(0, 0, 0, 0.7);
      padding: 0.5vmin;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      z-index: 20;
    }
    .viz-menu-btn {
      background: transparent;
      color: #aaa;
      border: none;
      padding: 0.8vmin 1.5vmin;
      font-size: 1.2vmin;
      font-weight: 500;
      cursor: pointer;
      border-radius: 4px;
      transition: all 0.2s ease;
    }
    .viz-menu-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
    }
    .viz-menu-btn.active {
      background: #5200ff;
      color: #fff;
    }
    .top-controls {
      display: flex;
      justify-content: space-between;
      width: 100%;
      padding: 0 4vmin;
      z-index: 10;
    }
    .session-controls {
      display: flex;
      gap: 2vmin;
      align-items: center;
    }
    .presets-container {
      display: flex;
      flex-direction: column;
      gap: 1.5vmin;
      padding: 1.5vmin;
      background: #111e;
      border-radius: 8px;
      margin-top: 1vmin;
      width: 100%;
      max-width: 80%;
      box-sizing: border-box;
      z-index: 10;
      border: 1px solid #333;
    }
    .presets-tabs {
      display: flex;
      gap: 1vmin;
      border-bottom: 1px solid #333;
      padding-bottom: 1vmin;
    }
    .preset-tab-btn {
      background: transparent;
      color: #888;
      border: none;
      border-bottom: 2px solid transparent;
      padding: 0.5vmin 1vmin;
      font-size: 1.4vmin;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease-in-out;
    }
    .preset-tab-btn:hover {
      color: #eee;
    }
    .preset-tab-btn.active {
      color: #ff25f6;
      border-bottom: 2px solid #ff25f6;
    }
    .preset-genre-list {
      display: flex;
      flex-wrap: wrap;
      gap: 1vmin;
      justify-content: flex-start;
      max-height: 12vmin;
      overflow-y: auto;
    }
    .preset-btn {
      background: #2a2a2a;
      color: #eee;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 0.5vmin 1vmin;
      font-size: 1.2vmin;
      cursor: pointer;
      transition: all 0.2s;
    }
    .preset-btn:hover {
      background: #5200ff;
      border-color: #5200ff;
    }
    .btn {
      background: #5200ff;
      color: white;
      border: none;
      padding: 0.8vmin 1.6vmin;
      border-radius: 4px;
      font-size: 1.4vmin;
      cursor: pointer;
    }
    .btn.secondary {
      background: #444;
    }
    .sessions-modal {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 100;
    }
    .modal-content {
      background: #2a2a2a;
      padding: 4vmin;
      border-radius: 8px;
      min-width: 40vmin;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      gap: 2vmin;
    }
    .session-list {
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1vmin;
    }
    .session-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #333;
      padding: 1.5vmin;
      border-radius: 4px;
      cursor: pointer;
    }
    .session-item:hover {
      background: #444;
    }
    /* Add pseudo-elements for centering while keeping elements visible when scrolling */
    #prompts-container::before,
    #prompts-container::after {
      content: '';
      flex: 1;
      min-width: 0.5vmin;
    }
    .add-prompt-button-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.5vmin;
      justify-content: flex-end;
      height: 100%;
      flex-shrink: 0;
    }
    .clear-all-btn {
      background: rgba(220, 53, 69, 0.15);
      color: #ff6b6b;
      border: 1px solid rgba(220, 53, 69, 0.35);
      padding: 0.8vmin 1.5vmin;
      border-radius: 6px;
      font-size: 1.25vmin;
      cursor: pointer;
      transition: all 0.2s ease-in-out;
      font-weight: 600;
      width: 100%;
      text-align: center;
      box-sizing: border-box;
    }
    .clear-all-btn:hover {
      background: rgba(220, 53, 69, 0.85);
      color: #fff;
      border-color: #ff3b30;
      box-shadow: 0 0 10px rgba(220, 53, 69, 0.4);
    }
    #settings-container {
      flex: 1;
      margin: 2vmin 0 1vmin 0;
    }
    .playback-container {
      display: flex;
      justify-content: center;
      align-items: center;
      flex-shrink: 0;
    }
    play-pause-button,
    add-prompt-button,
    reset-button {
      width: 12vmin;
      flex-shrink: 0;
    }
    prompt-controller {
      height: 100%;
      max-height: 80vmin;
      min-width: 14vmin;
      max-width: 16vmin;
      flex: 1;
    }
  `;

  @property({
    type: Object,
    attribute: false,
  })
  private prompts: Map<string, Prompt>;
  private nextPromptId: number; // Monotonically increasing ID for new prompts
  private session: LiveMusicSession;
  private readonly sampleRate = 48000;
  private audioContext = new (window.AudioContext || (window as any).webkitAudioContext)(
    {sampleRate: this.sampleRate},
  );
  private outputNode: GainNode = this.audioContext.createGain();
  private analyserNode: AnalyserNode = this.audioContext.createAnalyser();
  private dataArray: Uint8Array;
  private animationId: number;

  private nextStartTime = 0;
  private readonly bufferTime = 2; // adds an audio buffer in case of netowrk latency
  @state() private playbackState: PlaybackState = 'stopped';
  @property({type: Object})
  private filteredPrompts = new Set<string>();
  private connectionError = true;

  @state() private savedSessions: SessionData[] = [];
  @state() private showSessionsModal = false;
  @state() private activePresetCategory: 'Genres' | 'Instruments' | 'Effects & Feel' = 'Genres';
  @state() private vizStyle: 'waveform' | 'bar' | 'spectrum' = 'waveform';

  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;
  @query('settings-controller') private settingsController!: SettingsController;
  @query('#visualizer') private canvas!: HTMLCanvasElement;

  constructor(prompts: Map<string, Prompt>) {
    super();
    this.prompts = prompts;
    this.nextPromptId = this.prompts.size;
    this.outputNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination);
    this.analyserNode.fftSize = 256;
    const bufferLength = this.analyserNode.frequencyBinCount;
    this.dataArray = new Uint8Array(bufferLength);
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener('keydown', this.handleKeyDown);
  }

  override disconnectedCallback() {
    window.removeEventListener('keydown', this.handleKeyDown);
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
    super.disconnectedCallback();
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.getAttribute('contenteditable') === 'true')) {
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      this.handlePlayPause();
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      this.handleAddPrompt();
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      this.resetApp();
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      this.cycleVizStyle();
    }
  };

  private cycleVizStyle() {
    const styles: ('waveform' | 'bar' | 'spectrum')[] = ['waveform', 'bar', 'spectrum'];
    const currentIndex = styles.indexOf(this.vizStyle);
    const nextIndex = (currentIndex + 1) % styles.length;
    this.vizStyle = styles[nextIndex];
    this.toastMessage.show(`Visualization style: ${this.vizStyle.charAt(0).toUpperCase() + this.vizStyle.slice(1)}`);
  }

  override async firstUpdated() {
    if (!(process.env.API_KEY || process.env.GEMINI_API_KEY)) {
      this.toastMessage.show('Gemini API key is missing. Please check your settings.');
      console.error('API_KEY is not defined in the environment.');
      return;
    }
    
    // Set up ResizeObserver for responsive canvas scaling without fixed coordinates
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        this.canvas.width = width || 800;
        this.canvas.height = height || 400;
      }
    });
    if (this.canvas.parentElement) {
      resizeObserver.observe(this.canvas.parentElement);
    }

    await this.connectToSession();
    this.startVisualization();
    this.loadSavedSessions();
  }

  private startVisualization() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      this.animationId = requestAnimationFrame(draw);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

      if (this.vizStyle === 'waveform') {
        this.analyserNode.getByteTimeDomainData(this.dataArray);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#5200ff';
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#5200ff';
        ctx.beginPath();

        const sliceWidth = (this.canvas.width * 1.0) / this.dataArray.length;
        let x = 0;

        for (let i = 0; i < this.dataArray.length; i++) {
          const v = this.dataArray[i] / 128.0;
          const y = (v * this.canvas.height) / 2;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }

          x += sliceWidth;
        }

        ctx.lineTo(this.canvas.width, this.canvas.height / 2);
        ctx.stroke();
        ctx.shadowBlur = 0; // reset
      } else if (this.vizStyle === 'bar') {
        this.analyserNode.getByteFrequencyData(this.dataArray);
        ctx.shadowBlur = 0;
        
        const barWidth = (this.canvas.width / this.dataArray.length) * 1.5;
        let x = 0;

        for (let i = 0; i < this.dataArray.length; i++) {
          const percent = this.dataArray[i] / 255;
          const barHeight = percent * this.canvas.height * 0.85;

          const grad = ctx.createLinearGradient(0, this.canvas.height - barHeight, 0, this.canvas.height);
          grad.addColorStop(0, '#2af6de');
          grad.addColorStop(1, '#5200ff');
          ctx.fillStyle = grad;

          ctx.fillRect(x, this.canvas.height - barHeight, barWidth - 2, barHeight);
          x += barWidth;
        }
      } else if (this.vizStyle === 'spectrum') {
        this.analyserNode.getByteFrequencyData(this.dataArray);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ff25f6';
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#ff25f6';
        ctx.beginPath();

        const sliceWidth = (this.canvas.width * 1.0) / (this.dataArray.length - 1);
        let x = 0;
        ctx.moveTo(0, this.canvas.height);

        for (let i = 0; i < this.dataArray.length; i++) {
          const percent = this.dataArray[i] / 255;
          const y = this.canvas.height - percent * this.canvas.height * 0.85;

          if (i === 0) {
            ctx.lineTo(x, y);
          } else {
            const nextX = x + sliceWidth;
            const nextPercent = this.dataArray[Math.min(i + 1, this.dataArray.length - 1)] / 255;
            const nextY = this.canvas.height - nextPercent * this.canvas.height * 0.85;
            ctx.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
          }
          x += sliceWidth;
        }

        ctx.lineTo(this.canvas.width, this.canvas.height);
        ctx.stroke();

        const grad = ctx.createLinearGradient(0, 0, 0, this.canvas.height);
        grad.addColorStop(0, 'rgba(255, 37, 246, 0.4)');
        grad.addColorStop(1, 'rgba(82, 0, 255, 0)');
        ctx.fillStyle = grad;
        ctx.shadowBlur = 0; // reset
        ctx.lineTo(this.canvas.width, this.canvas.height);
        ctx.lineTo(0, this.canvas.height);
        ctx.closePath();
        ctx.fill();
      }
    };

    draw();
  }

  private exportAsMidi() {
    const activePrompts = Array.from(this.prompts.values()).filter(p => p.weight > 0);
    if (activePrompts.length === 0) {
      this.toastMessage.show('Please add or enable at least one prompt with weight > 0 to export.');
      return;
    }

    const buildMidiTrackBytes = (events: { delta: number, bytes: number[] }[]): number[] => {
      const trackData: number[] = [];
      for (const ev of events) {
        trackData.push(...encodeVarInt(ev.delta));
        trackData.push(...ev.bytes);
      }
      trackData.push(0x00, 0xFF, 0x2F, 0x00);

      const len = trackData.length;
      return [
        0x4D, 0x54, 0x72, 0x6B, // "MTrk"
        (len >> 24) & 0xFF,
        (len >> 16) & 0xFF,
        (len >> 8) & 0xFF,
        len & 0xFF,
        ...trackData
      ];
    };

    const numTracks = 1 + activePrompts.length;
    const header = [
      0x4D, 0x54, 0x68, 0x64, // "MThd"
      0x00, 0x00, 0x00, 0x06, // length of header (6)
      0x00, 0x01,             // Format 1 (multitrack)
      (numTracks >> 8) & 0xFF,
      numTracks & 0xFF,       // number of tracks
      0x00, 0x78              // Ticks per quarter note (120 ticks)
    ];

    const tracks: number[][] = [];

    // Tempo Track
    const tempoEvents = [
      { delta: 0, bytes: [0xFF, 0x03, 0x05, 0x65, 0x6C, 0x6C, 0x69, 0x73] }, // track name: "ellis"
      { delta: 0, bytes: [0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20] } // 120 bpm
    ];
    tracks.push(buildMidiTrackBytes(tempoEvents));

    // Active Prompts Tracks
    activePrompts.forEach((prompt, idx) => {
      const events: { delta: number, bytes: number[] }[] = [];
      
      const textBytes = new TextEncoder().encode(prompt.text);
      events.push({
        delta: 0,
        bytes: [0xFF, 0x03, textBytes.length, ...Array.from(textBytes)]
      });

      const weightText = `Weight: ${prompt.weight.toFixed(2)}`;
      const weightBytes = new TextEncoder().encode(weightText);
      events.push({
        delta: 0,
        bytes: [0xFF, 0x01, weightBytes.length, ...Array.from(weightBytes)]
      });

      let channel = idx % 16;
      if (channel === 9) channel = 10;
      const program = (idx * 8) % 128; // Spread sound changes
      events.push({
        delta: 0,
        bytes: [0xC0 | channel, program]
      });

      const textToUse = prompt.text || 'Ambient';
      const velocity = Math.min(127, Math.max(20, Math.round((prompt.weight / 2.0) * 127)));
      
      const scale = [60, 62, 64, 67, 69, 72, 74, 76, 79, 81]; // C major pentatonic
      
      for (let step = 0; step < 16; step++) {
        const charCode = textToUse.charCodeAt(step % textToUse.length);
        const note = scale[charCode % scale.length];

        const onDelta = step === 0 ? 0 : 12;
        events.push({
          delta: onDelta,
          bytes: [0x90 | channel, note, velocity] // Note On
        });

        events.push({
          delta: 48,
          bytes: [0x80 | channel, note, 0x00] // Note Off
        });
      }

      tracks.push(buildMidiTrackBytes(events));
    });

    const midiFileContent = new Uint8Array([
      ...header,
      ...tracks.flat()
    ]);

    const blob = new Blob([midiFileContent], { type: 'audio/midi' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ellis-patterns-${Date.now()}.mid`;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);

    this.toastMessage.show('MIDI configurations exported to MIDI file!');
  }

  private async saveCurrentSession() {
    const dateStr = new Date().toLocaleDateString();
    const firstActivePrompt = [...this.prompts.values()].find(p => p.weight > 0 && p.text.trim().length > 0);
    const activeText = firstActivePrompt ? firstActivePrompt.text.trim() : '';
    const suggestedName = activeText ? `${activeText} - ${dateStr}` : `Session - ${dateStr}`;

    const name = prompt('Session Name:', suggestedName);
    if (!name) return;

    const sessionData: SessionData = {
      id: Math.random().toString(36).substr(2, 9),
      name,
      prompts: Array.from(this.prompts.values()),
      settings: this.settingsController.computeConfig(),
      createdAt: Date.now()
    };

    try {
      const sessions = JSON.parse(localStorage.getItem('saved_sessions') || '[]');
      sessions.push(sessionData);
      localStorage.setItem('saved_sessions', JSON.stringify(sessions));
      this.toastMessage.show('Session saved locally!');
      this.loadSavedSessions();
    } catch (e) {
      console.error(e);
      this.toastMessage.show('Failed to save session');
    }
  }

  private async loadSavedSessions() {
    try {
      const sessions = JSON.parse(localStorage.getItem('saved_sessions') || '[]');
      this.savedSessions = sessions.sort((a: SessionData, b: SessionData) => b.createdAt - a.createdAt);
    } catch (e) {
      console.error(e);
    }
  }

  private async loadSession(sess: SessionData) {
    this.prompts = new Map(sess.prompts.map(p => [p.promptId, p]));
    this.nextPromptId = Math.max(...sess.prompts.map(p => {
        const id = parseInt(p.promptId.replace('prompt-', ''));
        return isNaN(id) ? 0 : id;
    })) + 1;
    this.showSessionsModal = false;
    this.toastMessage.show(`Session "${sess.name}" loaded`);
    this.requestUpdate();
    this.setSessionPrompts();
  }

  private async deleteSession(e: Event, id: string) {
    e.stopPropagation();
    if (!confirm('Are you sure?')) return;
    try {
      const sessions = JSON.parse(localStorage.getItem('saved_sessions') || '[]');
      const filtered = sessions.filter((s: SessionData) => s.id !== id);
      localStorage.setItem('saved_sessions', JSON.stringify(filtered));
      this.loadSavedSessions();
    } catch (e) {
      console.error(e);
    }
  }

  private async connectToSession() {
    // Create a new instance right before connecting to use the latest key
    const currentAi = new GoogleGenAI({
      apiKey: process.env.API_KEY || process.env.GEMINI_API_KEY,
      apiVersion: 'v1alpha',
    });

    try {
      this.session = await currentAi.live.music.connect({
        model: model,
        callbacks: {
          onmessage: async (e: LiveMusicServerMessage) => {
            console.log('Received message from the server:', e);
            if (e.setupComplete) {
              this.connectionError = false;
            }
            if (e.filteredPrompt) {
              this.filteredPrompts = new Set([
                ...this.filteredPrompts,
                e.filteredPrompt.text,
              ]);
              this.toastMessage.show(e.filteredPrompt.filteredReason);
            }
            if (e.serverContent?.audioChunks !== undefined) {
              if (
                this.playbackState === 'paused' ||
                this.playbackState === 'stopped'
              )
                return;
              const audioBuffer = await decodeAudioData(
                decode(e.serverContent?.audioChunks[0].data),
                this.audioContext,
                48000,
                2,
              );
              const source = this.audioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              if (this.nextStartTime === 0) {
                this.nextStartTime =
                  this.audioContext.currentTime + this.bufferTime;
                setTimeout(() => {
                  if (this.playbackState === 'loading') {
                    this.playbackState = 'playing';
                  }
                }, this.bufferTime * 1000);
              }

              if (this.nextStartTime < this.audioContext.currentTime) {
                console.log('under run');
                this.playbackState = 'loading';
                this.nextStartTime = 0;
                return;
              }
              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
            }
          },
          onerror: (e: any) => {
            console.error('Error occurred:', e);
            this.connectionError = true;
            this.stopAudio();
            this.toastMessage.show('Connection error: ' + (e.message || 'Unknown error'));
          },
          onclose: (e: any) => {
            console.log('Connection closed:', e);
            this.connectionError = true;
            this.stopAudio();
            this.toastMessage.show('Connection closed.');
          },
        },
      });
    } catch (err) {
      console.error('Failed to connect to music session:', err);
      this.connectionError = true;
      this.toastMessage.show('Failed to connect to server.');
    }
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.session) return;
    const promptsToSend = Array.from(this.prompts.values()).filter((p) => {
      return !this.filteredPrompts.has(p.text) && p.weight !== 0;
    });
    const weightedPrompts = promptsToSend.map((p) => {
      return {text: p.text, weight: p.weight};
    });
    try {
      await this.session.setWeightedPrompts({
        weightedPrompts,
      });
    } catch (e) {
      this.toastMessage.show(e.message);
      this.pauseAudio();
    }
  }, 200);

  private dispatchPromptsChange() {
    this.dispatchEvent(
      new CustomEvent('prompts-changed', {detail: this.prompts}),
    );
    setStoredPrompts(this.prompts);
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const {promptId, text, weight} = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found', promptId);
      return;
    }

    prompt.text = text;
    prompt.weight = weight;

    const newPrompts = new Map(this.prompts);
    newPrompts.set(promptId, prompt);

    this.prompts = newPrompts;

    this.setSessionPrompts();

    this.requestUpdate();
    this.dispatchPromptsChange();
  }

  /** Generates radial gradients for each prompt based on weight and color. */
  private makeBackground() {
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

    const MAX_WEIGHT = 0.5;
    const MAX_ALPHA = 0.6;

    const bg: string[] = [];

    [...this.prompts.values()].forEach((p, i) => {
      const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
      const alpha = Math.round(alphaPct * 0xff)
        .toString(16)
        .padStart(2, '0');

      const stop = p.weight / 2;
      const x = (i % 4) / 3;
      const y = Math.floor(i / 4) / 3;
      const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;

      bg.push(s);
    });

    return bg.join(', ');
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pauseAudio();
    } else if (
      this.playbackState === 'paused' ||
      this.playbackState === 'stopped'
    ) {
      if (this.connectionError) {
        await this.connectToSession();
        this.setSessionPrompts();
      }
      this.loadAudio();
    } else if (this.playbackState === 'loading') {
      this.stopAudio();
    }
    console.debug('handlePlayPause');
  }

  private pauseAudio() {
    this.session?.pause();
    this.playbackState = 'paused';
    this.outputNode.gain.setValueAtTime(1, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      0,
      this.audioContext.currentTime + 0.1,
    );
    this.nextStartTime = 0;
    this.outputNode = this.audioContext.createGain();
    this.outputNode.connect(this.analyserNode);
  }

  private loadAudio() {
    this.audioContext.resume();
    this.session?.play();
    this.playbackState = 'loading';
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
  }

  private stopAudio() {
    this.session?.stop();
    this.playbackState = 'stopped';
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(
      1,
      this.audioContext.currentTime + 0.1,
    );
    this.nextStartTime = 0;
  }

  private async handleAddPrompt() {
    const newPromptId = `prompt-${this.nextPromptId++}`;
    const usedColors = [...this.prompts.values()].map((p) => p.color);
    const newPrompt: Prompt = {
      promptId: newPromptId,
      text: 'New Prompt', // Default text
      weight: 0,
      color: getUnusedRandomColor(usedColors),
    };
    const newPrompts = new Map(this.prompts);
    newPrompts.set(newPromptId, newPrompt);
    this.prompts = newPrompts;

    await this.setSessionPrompts();

    // Wait for the component to update and render the new prompt.
    // Do not dispatch the prompt change event until the user has edited the prompt text.
    await this.updateComplete;

    // Find the newly added prompt controller element
    const newPromptElement = this.renderRoot.querySelector<PromptController>(
      `prompt-controller[promptId="${newPromptId}"]`,
    );
    if (newPromptElement) {
      // Scroll the prompts container to the new prompt element
      newPromptElement.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'end',
      });

      // Select the new prompt text
      const textSpan =
        newPromptElement.shadowRoot?.querySelector<HTMLSpanElement>('#text');
      if (textSpan) {
        textSpan.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(textSpan);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }

  private handlePromptRemoved(e: CustomEvent<string>) {
    e.stopPropagation();
    const promptIdToRemove = e.detail;
    if (this.prompts.has(promptIdToRemove)) {
      this.prompts.delete(promptIdToRemove);
      const newPrompts = new Map(this.prompts);
      this.prompts = newPrompts;
      this.setSessionPrompts();
      this.dispatchPromptsChange();
    } else {
      console.warn(
        `Attempted to remove non-existent prompt ID: ${promptIdToRemove}`,
      );
    }
  }

  // Handle scrolling X-axis the prompts container.
  private handlePromptsContainerWheel(e: WheelEvent) {
    const container = e.currentTarget as HTMLElement;
    if (e.deltaX !== 0) {
      // Prevent the default browser action (like page back/forward)
      e.preventDefault();
      container.scrollLeft += e.deltaX;
    }
  }

  private updateSettings = throttle(
    async (e: CustomEvent<LiveMusicGenerationConfig>) => {
      await this.session?.setMusicGenerationConfig({
        musicGenerationConfig: e.detail,
      });
    },
    200,
  );

  private async handleReset() {
    if (this.connectionError) {
      await this.connectToSession();
      this.setSessionPrompts();
    }
    this.pauseAudio();
    this.session.resetContext();
    this.settingsController.resetToDefaults();
    this.session?.setMusicGenerationConfig({
      musicGenerationConfig: {},
    });
    setTimeout(this.loadAudio.bind(this), 100);
  }

  override render() {
    return html`
      <div id="background" style=${styleMap({background: this.makeBackground()})}></div>
      <div class="viz-container">
        <canvas id="visualizer" width="800" height="400"></canvas>
        <div class="viz-menu" style="pointer-events: auto;">
          <button class="viz-menu-btn ${this.vizStyle === 'waveform' ? 'active' : ''}" @click=${() => this.vizStyle = 'waveform'}>Waveform</button>
          <button class="viz-menu-btn ${this.vizStyle === 'bar' ? 'active' : ''}" @click=${() => this.vizStyle = 'bar'}>Bar Graph</button>
          <button class="viz-menu-btn ${this.vizStyle === 'spectrum' ? 'active' : ''}" @click=${() => this.vizStyle = 'spectrum'}>Frequency Spectrum</button>
        </div>
      </div>

      <div class="top-controls">
        <div class="session-controls">
          <button class="btn secondary" @click=${() => this.showSessionsModal = true}>My Sessions</button>
          <button class="btn" @click=${this.saveCurrentSession}>Save Session</button>
          <button class="btn" style="background: #2575fc;" @click=${this.exportAsMidi}>Export MIDI</button>
        </div>
        <div class="playback-container">
          <reset-button @click=${this.resetApp}></reset-button>
          <play-pause-button
            .playbackState=${this.playbackState}
            @click=${this.handlePlayPause}></play-pause-button>
        </div>
      </div>

      <div class="presets-container">
        <div class="presets-tabs">
          <button class="preset-tab-btn ${this.activePresetCategory === 'Genres' ? 'active' : ''}" @click=${() => this.activePresetCategory = 'Genres'}>Genres</button>
          <button class="preset-tab-btn ${this.activePresetCategory === 'Instruments' ? 'active' : ''}" @click=${() => this.activePresetCategory = 'Instruments'}>Instruments</button>
          <button class="preset-tab-btn ${this.activePresetCategory === 'Effects & Feel' ? 'active' : ''}" @click=${() => this.activePresetCategory = 'Effects & Feel'}>Effects & Feel</button>
        </div>
        <div class="preset-genre-list">
          ${PRESET_CATEGORIES[this.activePresetCategory].map(item => html`
            <button class="preset-btn" @click=${() => this.handleAddPromptWithText(item.name, item.defaultVolume)}>${item.name}</button>
          `)}
        </div>
      </div>

      <div class="prompts-area">
        <div id="prompts-container"
          @prompt-removed=${this.handlePromptRemoved}
          @wheel=${this.handlePromptsContainerWheel}>
          ${this.renderPrompts()}
        </div>
        <div class="add-prompt-button-container">
          <add-prompt-button @click=${this.handleAddPrompt}></add-prompt-button>
          <button class="clear-all-btn" @click=${this.handleClearAll}>Clear All</button>
        </div>
      </div>

      <div id="settings-container">
        <settings-controller
          @settings-changed=${(e: CustomEvent<LiveMusicGenerationConfig>) => {
            this.session.setMusicGenerationConfig({ musicGenerationConfig: e.detail });
          }}></settings-controller>
      </div>

      ${this.showSessionsModal ? html`
        <div class="sessions-modal" @click=${() => this.showSessionsModal = false}>
          <div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
            <h2 style="margin-top: 0;">Your Saved Sessions</h2>
            <div class="session-list">
              ${this.savedSessions.length === 0 ? html`<p>No saved sessions yet.</p>` : ''}
              ${this.savedSessions.map(sess => html`
                <div class="session-item" @click=${() => this.loadSession(sess)}>
                  <div>
                    <div style="font-weight: bold;">${sess.name}</div>
                    <div style="font-size: 1.2vmin; color: #888;">${new Date(sess.createdAt).toLocaleString()}</div>
                  </div>
                  <button class="btn secondary" style="background: #900;" @click=${(e) => this.deleteSession(e, sess.id!)}>Delete</button>
                </div>
              `)}
            </div>
            <button class="btn secondary" @click=${() => this.showSessionsModal = false}>Close</button>
          </div>
        </div>
      ` : ''}

      <toast-message></toast-message>
    `;
  }

  private async handleAddPromptWithText(text: string, defaultVolume = 0.5) {
    const newPromptId = `prompt-${this.nextPromptId++}`;
    const usedColors = [...this.prompts.values()].map((p) => p.color);
    const newPrompt: Prompt = {
      promptId: newPromptId,
      text,
      weight: defaultVolume,
      color: getUnusedRandomColor(usedColors),
    };
    const newPrompts = new Map(this.prompts);
    newPrompts.set(newPromptId, newPrompt);
    this.prompts = newPrompts;

    await this.setSessionPrompts();
    this.requestUpdate();
    this.dispatchPromptsChange();
  }

  private handleClearAll() {
    if (!confirm('Are you sure you want to clear all prompts and reset to a clean state?')) {
      return;
    }
    this.prompts = new Map();
    this.nextPromptId = 0;
    this.setSessionPrompts();
    this.requestUpdate();
    this.dispatchPromptsChange();
    this.toastMessage.show('All prompts cleared.');
  }

  private resetApp() {
    if (!confirm('Reset everything?')) return;
    this.prompts = new Map();
    this.nextPromptId = 0;
    this.settingsController.resetToDefaults();
    this.requestUpdate();
    this.setSessionPrompts();
    this.dispatchPromptsChange();
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        .promptId=${prompt.promptId}
        filtered=${this.filteredPrompts.has(prompt.text)}
        .text=${prompt.text}
        .weight=${prompt.weight}
        .color=${prompt.color}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}

function gen(parent: HTMLElement) {
  const initialPrompts = getStoredPrompts();

  const pdj = new PromptDj(initialPrompts);
  parent.appendChild(pdj);
}

function getStoredPrompts(): Map<string, Prompt> {
  const {localStorage} = window;
  const storedPrompts = localStorage.getItem('prompts');

  if (storedPrompts) {
    try {
      const prompts = JSON.parse(storedPrompts) as Prompt[];
      console.log('Loading stored prompts', prompts);
      return new Map(prompts.map((prompt) => [prompt.promptId, prompt]));
    } catch (e) {
      console.error('Failed to parse stored prompts', e);
    }
  }

  console.log('No stored prompts, creating prompt presets');

  const numDefaultPrompts = Math.min(4, MUSICAL_TERMS.length);
  const shuffledPresetTexts = [...MUSICAL_TERMS].sort(
    () => Math.random() - 0.5,
  );
  const defaultPrompts: Prompt[] = [];
  const usedColors: string[] = [];
  for (let i = 0; i < numDefaultPrompts; i++) {
    const text = shuffledPresetTexts[i];
    const color = getUnusedRandomColor(usedColors);
    usedColors.push(color);
    defaultPrompts.push({
      promptId: `prompt-${i}`,
      text,
      weight: 0,
      color,
    });
  }
  // Randomly select up to 2 prompts to set their weight to 1.
  const promptsToActivate = [...defaultPrompts].sort(() => Math.random() - 0.5);
  const numToActivate = Math.min(2, defaultPrompts.length);
  for (let i = 0; i < numToActivate; i++) {
    if (promptsToActivate[i]) {
      promptsToActivate[i].weight = 1;
    }
  }
  return new Map(defaultPrompts.map((p) => [p.promptId, p]));
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  const storedPrompts = JSON.stringify([...prompts.values()]);
  const {localStorage} = window;
  localStorage.setItem('prompts', storedPrompts);
}

function main(container: HTMLElement) {
  gen(container);
}

main(document.body);

declare global {
  interface HTMLElementTagNameMap {
    'prompt-dj': PromptDj;
    'prompt-controller': PromptController;
    'settings-controller': SettingsController;
    'add-prompt-button': AddPromptButton;
    'play-pause-button': PlayPauseButton;
    'reset-button': ResetButton;
    'weight-slider': WeightSlider;
    'toast-message': ToastMessage;
  }
}

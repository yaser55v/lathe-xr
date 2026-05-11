/**
 * HandwheelSystem
 *
 * Refines the existing guided inspection interaction for Object_9.
 * Keeps the same ECS/world-space panel architecture, but upgrades the
 * panel into an animated expandable XR card with embedded AI chat.
 */

import {
  createSystem,
  createComponent,
  Types,
  Hovered,
  Pressed,
  PanelUI,
  PanelDocument,
  eq,
  MeshBasicMaterial,
  Color,
  Object3D,
  BackSide,
  AdditiveBlending,
} from "@iwsdk/core";
import type { Component as UIKitComponent } from "@pmndrs/uikit";
import type { Signal } from "@preact/signals-core";
import {
  getAIExplanation,
  getInstantExplanation,
  getPartKnowledge,
  getSupportedLanguage,
  type AIResponse,
  type Language,
  type MediaCard,
} from "./ai-service.js";

export const HandwheelState = {
  Idle: "Idle",
  Hovered: "Hovered",
  Active: "Active",
} as const;

type HandwheelStateValue = (typeof HandwheelState)[keyof typeof HandwheelState];
type LocalizedText = Record<Language, string>;
type LanguageSignal = Signal<Language>;

type PanelEntity = {
  setValue: (component: typeof PanelUI, key: "maxHeight" | "maxWidth", value: number) => void;
  getValue: (component: typeof PanelDocument, key: "document") => PanelDoc;
};

type PanelDoc = {
  getElementById(id: string): UIKitComponent | null;
};

type InputComponent = UIKitComponent & {
  element?: HTMLInputElement | HTMLTextAreaElement;
  setProperties: (properties: Record<string, unknown>) => void;
  focus?: (start?: number, end?: number, direction?: "forward" | "backward" | "none") => void;
};

type TextComponent = UIKitComponent & {
  setProperties: (properties: Record<string, unknown>) => void;
};

type ChatMessage = {
  role: "user" | "assistant" | "typing";
  text: string;
  media: MediaCard[];
};

const DEFAULT_PART_ID = "Object_179";
const COMPACT_PANEL_HEIGHT = 1.02;
const EXPANDED_PANEL_HEIGHT = 1.08;
const COMPACT_PANEL_WIDTH = 1.18;
const EXPANDED_PANEL_WIDTH = 2.12;
const PANEL_ENTRANCE_DURATION = 0.32;
const PANEL_EXPANSION_DURATION = 0.3;
const PANEL_ENTRANCE_Y_OFFSET = 0.11;
const MESSAGE_LIMIT = 3;

const copy = {
  infoLabel: {
    it: "ISPEZIONE PEZZO",
    en: "PART INSPECTION",
  },
  description: {
    it: "La grande ruota frontale usata per spostare manualmente il carro lungo l'asse e controllare l'avanzamento.",
    en: "The large front wheel used to move the carriage manually along the axis and control the feed motion.",
  },
  hint: {
    it: "Apri l'assistenza AI per una spiegazione contestuale del componente.",
    en: "Open AI assistance for a contextual explanation of this component.",
  },
  inputPlaceholder: {
    it: "Fai una domanda sul componente...",
    en: "Ask a question about the part...",
  },
  assistantIntro: {
    it: "Posso spiegarti questo componente, il suo movimento o un caso d'uso reale.",
    en: "I can explain this part, its motion, or a real machining use case.",
  },
} as const satisfies Record<string, LocalizedText>;

export const Handwheel = createComponent("Handwheel", {
  state: {
    type: Types.Enum,
    default: HandwheelState.Idle,
    enum: HandwheelState,
  },
});

export class HandwheelSystem extends createSystem({
  handwheel: { required: [Handwheel] },
  hovered: { required: [Handwheel, Hovered] },
  pressed: { required: [Handwheel, Pressed] },
  inspectionPanel: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/handwheel.json")],
  },
}) {
  private highlightColor!: Color;
  private wheelObject: Object3D | null = null;
  private outlineObject: Object3D | null = null;
  private inspectionPanelObject: Object3D | null = null;
  private inspectionPanelEntity: PanelEntity | null = null;
  private inspectionDocument: PanelDoc | null = null;
  private languageSignal: LanguageSignal | null = null;
  private activePartId = DEFAULT_PART_ID;

  private panelAnchorY = 0;
  private entranceProgress = 0;
  private expansionProgress = 0;
  private targetExpanded = false;
  private currentOpacity = 1;
  private typingPhase = 0;
  private mediaRevealProgress = 0;
  private aiRequestToken = 0;
  private hasStartedConversation = false;
  private draftMessage = "";
  private messages: ChatMessage[] = [];
  private inputListenerCleanup: (() => void) | null = null;
  private lastAppliedOpacity = -1;
  private elementCache: Map<string, UIKitComponent | null> = new Map();

  private readonly ROTATION_SPEED = Math.PI * 0.8;

  init() {
    this.highlightColor = new Color(0.0, 0.6, 1.0);
    this.languageSignal = this.globals.uiLanguage as LanguageSignal | null;

    if (this.languageSignal) {
      this.cleanupFuncs.push(
        this.languageSignal.subscribe(() => {
          this.renderPanel();
        }),
      );
    }

    this.queries.hovered.subscribe("qualify", (entity) => {
      const state = entity.getValue(Handwheel, "state") as HandwheelStateValue;
      if (state === HandwheelState.Idle) {
        entity.setValue(Handwheel, "state", HandwheelState.Hovered);
        this.applyHighlight(true);
      }
    });

    this.queries.hovered.subscribe("disqualify", (entity) => {
      const state = entity.getValue(Handwheel, "state") as HandwheelStateValue;
      if (state === HandwheelState.Hovered) {
        entity.setValue(Handwheel, "state", HandwheelState.Idle);
        this.applyHighlight(false);
      }
    });

    this.queries.pressed.subscribe("qualify", (entity) => {
      const state = entity.getValue(Handwheel, "state") as HandwheelStateValue;

      if (state === HandwheelState.Active) {
        entity.setValue(Handwheel, "state", HandwheelState.Hovered);
        this.applyHighlight(true);
        this.hidePanel();
      } else {
        entity.setValue(Handwheel, "state", HandwheelState.Active);
        this.applyHighlight(true);
        this.showPanel();
      }
    });

    this.queries.handwheel.subscribe("qualify", (entity) => {
      const obj = entity.object3D?.userData?.wheelObject as Object3D | undefined;
      if (obj) {
        this.wheelObject = obj;

        const glowShell = obj.clone(true);
        glowShell.traverse((child: any) => {
          if (child.isMesh) {
            child.material = new MeshBasicMaterial({
              color: this.highlightColor,
              side: BackSide,
              transparent: true,
              opacity: 0.4,
              blending: AdditiveBlending,
              depthWrite: false,
            });
            child.scale.multiplyScalar(1.03);
          }
        });

        if (obj.parent) {
          obj.parent.add(glowShell);
        }

        glowShell.visible = false;
        this.outlineObject = glowShell;
      }
    });

    this.queries.inspectionPanel.subscribe("qualify", (entity) => {
      this.inspectionPanelEntity = entity as unknown as PanelEntity;
      this.inspectionDocument = entity.getValue(PanelDocument, "document") as PanelDoc;
      this.inspectionPanelObject = entity.object3D!;
      this.panelAnchorY = entity.object3D!.position.y;
      this.bindPanelInteractions();
      this.renderPanel();
    });
  }

  update(delta: number) {
    this.updateWheel(delta);
    this.updatePanelMotion(delta);
    this.updateTypingIndicator(delta);
  }



  private updateWheel(delta: number) {
    for (const entity of this.queries.handwheel.entities) {
      const state = entity.getValue(Handwheel, "state") as HandwheelStateValue;
      if (state !== HandwheelState.Active || !this.wheelObject) continue;

      this.wheelObject.rotation.z -= this.ROTATION_SPEED * delta;
      if (this.outlineObject) {
        this.outlineObject.rotation.copy(this.wheelObject.rotation);
      }
    }
  }

  private updatePanelMotion(delta: number) {
    if (!this.inspectionPanelObject || !this.inspectionPanelEntity) {
      return;
    }

    if (!this.inspectionPanelObject.visible) {
      return;
    }

    this.entranceProgress = moveToward(this.entranceProgress, 1, delta / PANEL_ENTRANCE_DURATION);
    this.expansionProgress = moveToward(
      this.expansionProgress,
      this.targetExpanded ? 1 : 0,
      delta / PANEL_EXPANSION_DURATION,
    );
    this.mediaRevealProgress = moveToward(
      this.mediaRevealProgress,
      this.getLatestAssistantMessage()?.media.length ? 1 : 0,
      delta / 0.22,
    );

    const entranceEased = easeOutCubic(this.entranceProgress);
    const expansionEased = easeOutCubic(this.expansionProgress);
    const panelHeight = lerp(COMPACT_PANEL_HEIGHT, EXPANDED_PANEL_HEIGHT, expansionEased);
    const panelWidth = lerp(COMPACT_PANEL_WIDTH, EXPANDED_PANEL_WIDTH, expansionEased);

    this.inspectionPanelEntity.setValue(PanelUI, "maxHeight", panelHeight);
    this.inspectionPanelEntity.setValue(PanelUI, "maxWidth", panelWidth);

    this.inspectionPanelObject.position.y =
      this.panelAnchorY -
      (1 - entranceEased) * PANEL_ENTRANCE_Y_OFFSET +
      expansionEased * 0.015;

    this.currentOpacity = entranceEased;
    if (Math.abs(this.currentOpacity - this.lastAppliedOpacity) > 0.001) {
      this.applyObjectOpacity(this.inspectionPanelObject, this.currentOpacity);
      this.lastAppliedOpacity = this.currentOpacity;
    }

    this.applyModeStyles(expansionEased);
    this.applyMediaStyles(this.mediaRevealProgress);
  }

  private updateTypingIndicator(delta: number) {
    const typingMessage = this.getLatestTypingMessage();
    if (!typingMessage) {
      this.typingPhase = 0;
      return;
    }

    const oldPhase = this.typingPhase;
    this.typingPhase += delta * 4;
    const frame = Math.floor(this.typingPhase) % 3;
    const oldFrame = Math.floor(oldPhase) % 3;

    if (frame !== oldFrame || oldPhase === 0) {
      typingMessage.text = frame === 0 ? "." : frame === 1 ? ".." : "...";
      this.renderMessages();
    }
  }

  private showPanel() {
    if (!this.inspectionPanelObject) return;

    this.inspectionPanelObject.visible = true;
    this.entranceProgress = 0;
    this.targetExpanded = false;
    this.expansionProgress = 0;
    this.mediaRevealProgress = 0;
    this.renderPanel();
    this.applyObjectOpacity(this.inspectionPanelObject, 0);
  }

  private hidePanel() {
    this.aiRequestToken += 1;
    this.targetExpanded = false;
    this.hasStartedConversation = false;
    this.draftMessage = "";
    this.messages = [];
    this.renderPanel();

    if (this.inspectionPanelObject) {
      this.inspectionPanelObject.visible = false;
      this.inspectionPanelObject.position.y = this.panelAnchorY;
    }

    this.applyHighlight(false);
  }

  private bindPanelInteractions() {
    this.setClickHandler("language-button", () => {
      if (!this.languageSignal) return;
      this.languageSignal.value = this.languageSignal.peek() === "it" ? "en" : "it";
    });

    this.setClickHandler("close-button", () => {
      this.closeExperience();
    });

    this.setClickHandler("ask-ai-button", () => {
      this.expandChat();
    });

    this.setClickHandler("send-button", () => {
      this.submitDraft();
    });

    this.bindComposerInput();
  }

  private bindComposerInput() {
    const input = this.getInputComponent("chat-input");
    if (!input) return;

    input.setProperties({
      value: this.draftMessage,
      placeholder: copy.inputPlaceholder[this.getLanguage()],
      onValueChange: (value: string) => {
        this.draftMessage = value;
        input.setProperties({ value });
      },
    });

    if (this.inputListenerCleanup) {
      this.inputListenerCleanup();
      this.inputListenerCleanup = null;
    }

    const element = input.element;
    if (!element) return;

    const onKeyDown: EventListener = (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "Enter" || keyboardEvent.shiftKey) {
        return;
      }

      keyboardEvent.preventDefault();
      this.submitDraft();
    };

    element.addEventListener("keydown", onKeyDown);
    this.inputListenerCleanup = () => {
      element.removeEventListener("keydown", onKeyDown);
    };
    this.cleanupFuncs.push(this.inputListenerCleanup);
  }

  private expandChat() {
    this.targetExpanded = true;
    this.renderPanel();
    this.focusInputSoon();

    if (this.hasStartedConversation) {
      return;
    }

    this.hasStartedConversation = true;
    this.messages = [
      {
        role: "assistant",
        text: copy.assistantIntro[this.getLanguage()],
        media: [],
      },
    ];
    this.renderPanel();
  }

  private submitDraft() {
    const question = this.draftMessage.trim();
    if (!question) {
      return;
    }

    this.sendQuestion(question);
  }

  private sendQuestion(question: string) {
    const language = this.getLanguage();
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) {
      return;
    }

    this.messages.push({
      role: "user",
      text: normalizedQuestion,
      media: [],
    });
    this.messages.push({
      role: "typing",
      text: ".",
      media: [],
    });
    this.trimMessages();
    this.draftMessage = "";
    this.renderPanel();
    this.focusInputSoon();

    const requestToken = ++this.aiRequestToken;
    const typingIndex = this.messages.length - 1;
    const fallback = getInstantExplanation(this.activePartId, language, normalizedQuestion);
    let fallbackShown = false;
    let liveResult: AIResponse | null = null;

    window.setTimeout(() => {
      if (requestToken !== this.aiRequestToken) {
        return;
      }

      fallbackShown = true;
      this.replaceTypingMessage(typingIndex, fallback);

      if (liveResult) {
        const resolvedLiveResult = liveResult;
        window.setTimeout(() => {
          if (requestToken !== this.aiRequestToken) {
            return;
          }
          this.replaceAssistantMessage(typingIndex, resolvedLiveResult);
        }, 0);
      }
    }, 220);

    void getAIExplanation(this.activePartId, language, normalizedQuestion).then((result) => {
      if (!result || requestToken !== this.aiRequestToken) {
        return;
      }

      if (fallbackShown) {
        this.replaceAssistantMessage(typingIndex, result);
        return;
      }

      liveResult = result;
    });
  }

  private replaceTypingMessage(index: number, response: AIResponse) {
    if (!this.messages[index]) {
      return;
    }

    this.messages[index] = {
      role: "assistant",
      text: response.text,
      media: response.media,
    };
    this.renderPanel();
  }

  private replaceAssistantMessage(index: number, response: AIResponse) {
    if (!this.messages[index]) {
      return;
    }

    this.messages[index] = {
      role: "assistant",
      text: response.text,
      media: response.media,
    };
    this.renderPanel();
  }

  private closeExperience() {
    const entity = this.queries.handwheel.entities.values().next().value as
      | { setValue: (component: typeof Handwheel, key: "state", value: HandwheelStateValue) => void }
      | undefined;

    if (entity) {
      entity.setValue(Handwheel, "state", HandwheelState.Idle);
    }

    this.hidePanel();
  }

  private renderPanel() {
    if (!this.inspectionDocument) {
      return;
    }

    this.elementCache.clear();
    const language = this.getLanguage();
    const knowledge = getPartKnowledge(this.activePartId);

    this.setText("card-label", copy.infoLabel[language]);
    this.setText("language-button-text", language.toUpperCase());
    this.setText("part-title", knowledge.partName[language]);
    this.setText("part-description", copy.description[language]);
    this.setText("part-hint", copy.hint[language]);

    this.renderMessages();
    this.renderMedia();
    this.renderComposer();
    this.applyModeStyles(easeOutCubic(this.expansionProgress));
  }

  private renderMessages() {
    if (!this.inspectionDocument) {
      return;
    }

    const visibleMessages = this.messages.slice(-MESSAGE_LIMIT);

    for (let index = 0; index < MESSAGE_LIMIT; index++) {
      const message = visibleMessages[index];
      const row = this.getElement(`message-${index}-row`);
      const bubble = this.getElement(`message-${index}-bubble`);
      const text = this.getElement(`message-${index}-text`);

      if (!row || !bubble || !text) {
        continue;
      }

      if (!message) {
        row.setProperties({ display: "none" });
        continue;
      }

      row.setProperties({
        display: "flex",
        justifyContent: message.role === "user" ? "flex-end" : "flex-start",
        minHeight: 5.4,
      });

      bubble.setProperties({
        backgroundColor: message.role === "user" ? "#173044" : "#161b22",
        borderColor: message.role === "user" ? "#275c81" : "#27313b",
        width: 68,
      });

      (text as TextComponent).setProperties({
        text: message.text,
        color: message.role === "user" ? "#f5fbff" : "#edf0f4",
      });
    }
  }

  private renderMedia() {
    const latestAssistant = this.getLatestAssistantMessage();
    const media = latestAssistant?.media ?? [];

    for (let index = 0; index < 2; index++) {
      const card = this.getElement(`media-${index}-card`);
      const kind = this.getElement(`media-${index}-kind`);
      const title = this.getElement(`media-${index}-title`);
      const subtitle = this.getElement(`media-${index}-subtitle`);
      const item = media[index];

      if (!card || !kind || !title || !subtitle) {
        continue;
      }

      if (!item) {
        card.setProperties({ display: "none" });
        continue;
      }

      card.setProperties({ display: "flex" });
      (kind as TextComponent).setProperties({
        text: item.kind === "image" ? "IMAGE" : "VIDEO",
      });
      (title as TextComponent).setProperties({
        text: item.title[this.getLanguage()],
      });
      (subtitle as TextComponent).setProperties({
        text: item.subtitle[this.getLanguage()],
      });
    }
  }

  private renderComposer() {
    const input = this.getInputComponent("chat-input");
    if (!input) {
      return;
    }

    input.setProperties({
      value: this.draftMessage,
      placeholder: copy.inputPlaceholder[this.getLanguage()],
    });
  }

  private applyModeStyles(progress: number) {
    const infoShell = this.getElement("info-shell");
    const chatShell = this.getElement("chat-shell");
    if (!infoShell || !chatShell) {
      return;
    }

    const showChat = this.targetExpanded || progress > 0.001;
    const hideInfo = progress > 0.14 || this.targetExpanded;

    infoShell.setProperties({
      display: hideInfo ? "none" : "flex",
      opacity: hideInfo ? 0 : Math.max(0, 1 - progress * 6),
    });

    chatShell.setProperties({
      display: showChat ? "flex" : "none",
      opacity: progress < 0.2 ? 0 : Math.min(1, (progress - 0.2) / 0.8),
    });
  }

  private applyMediaStyles(progress: number) {
    const mediaGrid = this.getElement("media-grid");
    if (!mediaGrid) {
      return;
    }

    const hasMedia = this.getLatestAssistantMessage()?.media.length;
    mediaGrid.setProperties({
      display: hasMedia ? "flex" : "none",
      opacity: progress,
    });
  }

  private getLatestAssistantMessage() {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      if (this.messages[index].role === "assistant") {
        return this.messages[index];
      }
    }

    return null;
  }

  private getLatestTypingMessage() {
    for (let index = this.messages.length - 1; index >= 0; index--) {
      if (this.messages[index].role === "typing") {
        return this.messages[index];
      }
    }

    return null;
  }

  private trimMessages() {
    if (this.messages.length <= MESSAGE_LIMIT) {
      return;
    }

    this.messages = this.messages.slice(-MESSAGE_LIMIT);
  }

  private getLanguage(): Language {
    return getSupportedLanguage(this.languageSignal?.peek());
  }

  private getElement(id: string) {
    if (this.elementCache.has(id)) {
      return this.elementCache.get(id) ?? null;
    }
    const element = this.inspectionDocument?.getElementById(id) ?? null;
    this.elementCache.set(id, element);
    return element;
  }

  private getInputComponent(id: string) {
    return this.getElement(id) as InputComponent | null;
  }

  private setText(id: string, value: string) {
    const element = this.getElement(id) as TextComponent | null;
    if (!element) {
      return;
    }

    element.setProperties({ text: value });
  }

  private setClickHandler(id: string, handler: () => void) {
    const element = this.getElement(id);
    if (!element) {
      return;
    }

    element.setProperties({
      onClick: (event: { stopPropagation?: () => void }) => {
        event.stopPropagation?.();
        handler();
      },
    });
  }

  private focusInputSoon() {
    window.setTimeout(() => {
      this.getInputComponent("chat-input")?.focus?.();
    }, 50);
  }

  private applyHighlight(on: boolean) {
    if (this.outlineObject) {
      this.outlineObject.visible = on;
    }
  }

  private applyObjectOpacity(object: Object3D, opacity: number) {
    object.traverse((child: any) => {
      const material = child.material;
      if (!material) {
        return;
      }

      if (Array.isArray(material)) {
        material.forEach((item) => this.setMaterialOpacity(item, opacity));
        return;
      }

      this.setMaterialOpacity(material, opacity);
    });
  }

  private setMaterialOpacity(material: { transparent?: boolean; opacity?: number }, opacity: number) {
    material.transparent = true;
    material.opacity = opacity;
  }
}

function moveToward(current: number, target: number, step: number) {
  if (current === target) {
    return current;
  }

  if (current < target) {
    return Math.min(target, current + step);
  }

  return Math.max(target, current - step);
}

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

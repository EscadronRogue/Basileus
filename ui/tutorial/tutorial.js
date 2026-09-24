// ui/tutorial/tutorial.js - the guide that walks a player through the
// tutorial game (ui/tutorial/steps.js).
//
// A coach card says what is going on and what to do next; a spotlight and an
// arrow point at the control to use. The guide follows the game through the
// controller's render hook and a light poll (some steps wait on panel clicks
// that do not re-render the whole game). If the player moves on before a
// step is done, the guide skips to the first step of where they are now.
import { TUTORIAL_PHASE_TIPS, TUTORIAL_STEPS } from './steps.js';

const POLL_MS = 250;
const SPOTLIGHT_PAD = 6;
const ARROW_SIZE = 44;

function resolveTarget(step) {
  if (!step?.target || typeof document === 'undefined') return null;
  const element = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
  if (!element || !element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? element : null;
}

function text(value, context) {
  return typeof value === 'function' ? value(context) : (value || '');
}

export class TutorialGuide {
  constructor({ steps = TUTORIAL_STEPS, onLeave = null, onFinish = null } = {}) {
    this.steps = steps;
    this.index = 0;
    this.controller = null;
    this.onLeave = onLeave;
    this.onFinish = onFinish;
    this.collapsed = false;
    this.scrolledFor = null;
    this.renderedKey = null;
    this.shownIndex = null;
    this.frame = null;
    this.poll = null;
    this.root = null;
  }

  context() {
    return { state: this.controller?.state || null, controller: this.controller };
  }

  get step() {
    return this.steps[this.index] || null;
  }

  mount(controller) {
    this.controller = controller;
    document.body.classList.add('tutorial-active');
    this.root = document.createElement('div');
    this.root.className = 'tutorial-layer';
    this.root.innerHTML = `
      <div class="tutorial-spotlight" hidden></div>
      <svg class="tutorial-arrow" hidden viewBox="0 0 48 48" width="${ARROW_SIZE}" height="${ARROW_SIZE}" aria-hidden="true">
        <path d="M4 24 H36 M26 12 L40 24 L26 36" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <aside class="tutorial-coach" role="dialog" aria-modal="false" aria-labelledby="tutorialCoachTitle">
        <div class="tutorial-coach-head">
          <span class="tutorial-coach-kicker"></span>
          <button type="button" class="tutorial-coach-toggle" data-tutorial="toggle" aria-expanded="true">Hide</button>
        </div>
        <h2 class="tutorial-coach-title" id="tutorialCoachTitle"></h2>
        <div class="tutorial-coach-content">
          <p class="tutorial-coach-body"></p>
          <p class="tutorial-coach-task"></p>
          <div class="tutorial-coach-actions">
            <button type="button" class="btn-secondary" data-tutorial="back">Back</button>
            <button type="button" class="btn-primary" data-tutorial="next">Next</button>
            <button type="button" class="tutorial-coach-leave" data-tutorial="leave">Leave tutorial</button>
          </div>
        </div>
      </aside>
    `;
    document.body.append(this.root);
    this.spotlight = this.root.querySelector('.tutorial-spotlight');
    this.arrow = this.root.querySelector('.tutorial-arrow');
    this.coach = this.root.querySelector('.tutorial-coach');
    this.root.addEventListener('click', (event) => {
      const action = event.target.closest('[data-tutorial]')?.dataset.tutorial;
      if (action === 'next') this.next();
      else if (action === 'back') this.back();
      else if (action === 'toggle' || action === 'hint-hide') this.toggle();
      else if (action === 'leave') this.onLeave?.();
      else if (action === 'finish') this.onFinish?.();
    });
    this.poll = window.setInterval(() => this.update(), POLL_MS);
    const follow = () => {
      this.place();
      this.frame = window.requestAnimationFrame(follow);
    };
    this.frame = window.requestAnimationFrame(follow);
    this.update();
  }

  destroy() {
    window.clearInterval(this.poll);
    window.cancelAnimationFrame(this.frame);
    this.root?.remove();
    document.body.classList.remove('tutorial-active');
  }

  applies(step) {
    const context = this.context();
    return Boolean(context.state && step && (!step.when || step.when(context)));
  }

  // Keeps the current step in line with the game: skips steps whose moment
  // has passed and steps the player already did.
  sync() {
    // A step can name the step to return to when it stops applying, such
    // as "pick a dynasty" falling back to "pick a seat" if the rope is dropped.
    if (!this.applies(this.step) && this.step?.fallback) {
      const fallback = this.steps.findIndex((step) => step.id === this.step.fallback);
      if (fallback >= 0 && this.applies(this.steps[fallback])) this.index = fallback;
    }
    if (!this.applies(this.step)) {
      const forward = this.steps.findIndex((step, index) => index > this.index && this.applies(step));
      const anywhere = this.steps.findIndex((step) => this.applies(step));
      const found = forward >= 0 ? forward : anywhere;
      if (found >= 0) this.index = found;
    }
    const context = this.context();
    while (this.step?.done?.(context) && this.index < this.steps.length - 1) {
      const nextIndex = this.index + 1;
      if (!this.applies(this.steps[nextIndex])) {
        const forward = this.steps.findIndex((step, index) => index > this.index && this.applies(step));
        if (forward < 0) break;
        this.index = forward;
      } else {
        this.index = nextIndex;
      }
    }
  }

  next() {
    const forward = this.steps.findIndex((step, index) => index > this.index && this.applies(step));
    if (forward >= 0) this.index = forward;
    this.renderedKey = null;
    this.update();
  }

  back() {
    for (let index = this.index - 1; index >= 0; index -= 1) {
      if (this.applies(this.steps[index]) && !this.steps[index].done?.(this.context())) {
        this.index = index;
        break;
      }
    }
    this.renderedKey = null;
    this.update();
  }

  toggle() {
    this.collapsed = !this.collapsed;
    this.renderedKey = null;
    this.update();
  }

  update() {
    if (!this.root || !this.controller?.state) return;
    this.sync();
    const step = this.step;
    const state = this.controller.state;
    // A hidden card comes back when there is something new to do.
    if (this.index !== this.shownIndex) {
      this.shownIndex = this.index;
      if (!step?.free) this.collapsed = false;
    }
    const phaseTip = step?.free ? TUTORIAL_PHASE_TIPS[state.phase] : null;
    const task = phaseTip || text(step?.task, this.context());
    const key = `${this.index}:${this.collapsed}:${state.round}:${state.phase}:${Boolean(state.lastCoupResult)}:${task}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    this.renderCoach(step, phaseTip);
  }

  renderCoach(step, phaseTip) {
    if (!step) return;
    const context = this.context();
    const guided = this.steps.filter((entry) => !entry.free && !entry.final);
    const position = guided.indexOf(step);
    this.coach.querySelector('.tutorial-coach-kicker').textContent = step.final
      ? 'Tutorial complete'
      : step.free
        ? `Tutorial · Round ${context.state.round} of ${context.state.maxRounds}`
        : `Tutorial · Step ${position + 1} of ${guided.length}`;
    this.coach.querySelector('.tutorial-coach-title').textContent = step.title;
    this.coach.querySelector('.tutorial-coach-body').textContent = text(step.body, context);
    this.coach.querySelector('.tutorial-coach-task').textContent = phaseTip || text(step.task, context);
    this.coach.classList.toggle('is-collapsed', this.collapsed);
    this.coach.classList.toggle('is-waiting', Boolean(step.done) && !step.free);
    const toggle = this.coach.querySelector('[data-tutorial="toggle"]');
    toggle.textContent = this.collapsed ? 'Show' : 'Hide';
    toggle.setAttribute('aria-expanded', this.collapsed ? 'false' : 'true');

    const actions = this.coach.querySelector('.tutorial-coach-actions');
    const canGoBack = this.steps.some((entry, index) => index < this.index && this.applies(entry) && !entry.done?.(context));
    const hasNext = this.steps.some((entry, index) => index > this.index && this.applies(entry));
    const waiting = Boolean(step.done) && !step.optional;
    if (step.final) {
      actions.innerHTML = `
        <button type="button" class="btn-primary" data-tutorial="finish">Set up a real game</button>
      `;
    } else {
      actions.innerHTML = `
        <button type="button" class="btn-secondary" data-tutorial="back" ${canGoBack ? '' : 'hidden'}>Back</button>
        <button type="button" class="btn-primary" data-tutorial="next" ${hasNext && !step.free ? '' : 'hidden'}>${waiting ? 'Skip this step' : 'Next'}</button>
        <button type="button" class="btn-secondary" data-tutorial="hint-hide" ${!hasNext && waiting ? '' : 'hidden'}>Let me look around</button>
        <button type="button" class="tutorial-coach-leave" data-tutorial="leave">Leave tutorial</button>
      `;
    }
    this.scrolledFor = null;
  }

  // Moves the spotlight and arrow onto the step's target, every frame.
  place() {
    if (!this.root) return;
    const step = this.step;
    const target = this.collapsed || step?.free ? null : resolveTarget(step);
    if (!target) {
      this.spotlight.hidden = true;
      this.arrow.toggleAttribute('hidden', true);
      this.coach.classList.remove('is-raised');
      return;
    }
    if (this.scrolledFor !== step.id) {
      this.scrolledFor = step.id;
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
    const rect = target.getBoundingClientRect();
    this.spotlight.hidden = false;
    Object.assign(this.spotlight.style, {
      left: `${rect.left - SPOTLIGHT_PAD}px`,
      top: `${rect.top - SPOTLIGHT_PAD}px`,
      width: `${rect.width + SPOTLIGHT_PAD * 2}px`,
      height: `${rect.height + SPOTLIGHT_PAD * 2}px`,
    });

    // Point from the left when there is room, else from above, else below.
    this.arrow.toggleAttribute('hidden', false);
    let left;
    let top;
    let angle;
    if (rect.left - SPOTLIGHT_PAD - ARROW_SIZE - 6 >= 8) {
      left = rect.left - SPOTLIGHT_PAD - ARROW_SIZE - 6;
      top = rect.top + Math.min(rect.height, 80) / 2 - ARROW_SIZE / 2;
      angle = 0;
    } else if (rect.top - SPOTLIGHT_PAD - ARROW_SIZE - 6 >= 8) {
      left = rect.left + Math.min(rect.width, 120) / 2 - ARROW_SIZE / 2;
      top = rect.top - SPOTLIGHT_PAD - ARROW_SIZE - 6;
      angle = 90;
    } else {
      left = rect.left + Math.min(rect.width, 120) / 2 - ARROW_SIZE / 2;
      top = rect.bottom + SPOTLIGHT_PAD + 6;
      angle = -90;
    }
    this.arrow.style.left = `${left}px`;
    this.arrow.style.top = `${top}px`;
    this.arrow.style.setProperty('--tutorial-arrow-angle', `${angle}deg`);

    // The coach card sits in the bottom-left corner; move it to the top-left
    // when the target is down there.
    const coachRect = this.coach.getBoundingClientRect();
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const bottomZoneTop = viewportHeight - coachRect.height - 40;
    const inBottomZone = rect.left < coachRect.width + 40 && rect.bottom > bottomZoneTop;
    this.coach.classList.toggle('is-raised', inBottomZone);
  }
}

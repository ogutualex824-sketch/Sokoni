/* ============================================================================
   SOKONI — Verification Code Field (single input)
   ----------------------------------------------------------------------------
   ONE premium verification input, mounted by three pages that each used to ship
   their own six-box grid (.otp-digit / .otp-b / .otpb) with three copies of the
   focus-jumping logic.

   Why a single field, not six boxes:

     · iOS SMS AutoFill fills exactly ONE field. In a six-box grid Safari fills
       the first box with the whole code, the maxlength="1" truncates it to one
       digit, and the other five stay empty — the "tap the suggestion" path was
       broken by construction.
     · Pasting "899297" into box 3 used to scatter digits from box 3 onward.
     · Android's keyboard suggestion has the same one-field assumption.

   API — one call, no page-level event wiring:

     const otp = SokoniOtp.mount('#otpMount', {
       length:     6,
       onComplete: (code) => verify(code),   // fires once, when full
       label:      'Verification code',
     });

     otp.value()            → '899297'
     otp.clear()            → wipe + re-arm (call on resend / failed attempt)
     otp.focus()
     otp.error(true|false)  → aria-invalid + red border
     otp.destroy()          → aborts the WebOTP listener

   The caller keeps its own verify function and its own backend call. This
   component never talks to a server.
============================================================================ */
(function (global) {
  'use strict';

  /* Styling lives with the component so the three pages cannot drift apart again.
     Every colour resolves through a CSS var with a fallback, so each page's own
     premium theme (--acc / --sk-accent) drives it and page CSS can still override. */
  var CSS = [
    /* Four stylesheets carry a global iOS-zoom guard on inputs. The strongest is
       sokoni-premium-v2.css:

         input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])
           { font-size: max(16px, 1em) !important }

       Every :not() contributes its argument's specificity, so that selector scores (0,4,1)
       WITH !important — it outranks any class-based rule this component could reasonably
       write, and the field would render at a flat 16px with no tracking. The font-size is
       therefore applied inline with priority at mount (see setFont); an inline !important
       is the one thing a stylesheet !important cannot outrank, and it ends the arms race
       instead of escalating it.

       The guard's PURPOSE is preserved: it exists to stop iOS zooming the viewport when a
       sub-16px field takes focus, and 24px is well above that 16px floor.

       --sk-otp-fs keeps the size responsive — the media query below moves the variable,
       and the inline declaration reads through to it. */
    '.sk-otp{position:relative;--sk-otp-fs:24px}',
    '.sk-otp-in{',
    /* 16px minimum, or iOS Safari zooms the viewport on focus. 24px here because a
       verification code is the one thing the user is reading back off a lock screen. */
    '  width:100%;box-sizing:border-box;display:block;',
    '  min-height:56px;padding:14px 16px;',
    '  font-size:24px;font-weight:700;font-family:inherit;',
    '  text-align:center;',
    /* Tracking makes six digits legible at a glance. text-indent cancels the trailing
       letter-space that would otherwise push the centred text half a character left. */
    '  letter-spacing:.42em;text-indent:.42em;',
    '  font-variant-numeric:tabular-nums;',
    '  color:var(--text,var(--txt,#fff));',
    '  background:var(--surf2,var(--surface,rgba(255,255,255,.05)));',
    '  border:1px solid var(--border,var(--bor,rgba(255,255,255,.14)));',
    '  border-radius:var(--r,12px);',
    '  outline:none;transition:border-color .15s ease,box-shadow .15s ease;',
    '}',
    '.sk-otp-in::placeholder{',
    '  font-size:15px;font-weight:600;letter-spacing:normal;text-indent:0;',
    '  color:var(--muted,rgba(255,255,255,.38));',
    '}',
    '.sk-otp-in:focus{',
    '  border-color:var(--acc,var(--sk-accent,#71ff00));',
    '  box-shadow:0 0 0 3px color-mix(in srgb,var(--acc,#71ff00) 18%,transparent);',
    '}',
    '.sk-otp-in.is-full{border-color:var(--acc,var(--sk-accent,#71ff00))}',
    '.sk-otp-in[aria-invalid="true"]{border-color:#ff3d3d}',
    '.sk-otp-in:disabled{opacity:.6}',
    '.sk-otp-hint{',
    '  margin:7px 2px 0;font-size:11px;line-height:1.4;',
    '  color:var(--muted,rgba(255,255,255,.38));text-align:center;',
    '}',
    /* Still above the 16px no-zoom floor on the narrowest phones. */
    '@media (max-width:360px){.sk-otp{--sk-otp-fs:21px}.sk-otp-in{letter-spacing:.3em;text-indent:.3em}}',

    /* ── 6-box grid (boxes: true mode) ──────────────────────────────────────── */
    '.sk-otp-boxes{display:flex;gap:8px;justify-content:center;width:100%;}',
    '.sk-otp-box{',
    '  flex:1;min-width:0;max-width:52px;aspect-ratio:1/1;padding:0;',
    '  text-align:center;',
    '  font-weight:700;font-variant-numeric:tabular-nums;',
    '  color:var(--text,var(--txt,#fff));',
    '  background:var(--surf2,var(--surface,rgba(255,255,255,.07)));',
    '  border:1.5px solid var(--border,var(--bor,rgba(255,255,255,.14)));',
    '  border-radius:var(--r,12px);',
    '  outline:none;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease;',
    '  cursor:text;caret-color:transparent;',
    '  -webkit-tap-highlight-color:transparent;',
    '}',
    '.sk-otp-box:focus{',
    '  border-color:var(--acc,var(--sk-accent,#71ff00));',
    '  box-shadow:0 0 0 3px color-mix(in srgb,var(--acc,#71ff00) 18%,transparent);',
    '  background:rgba(255,255,255,.1);',
    '}',
    '.sk-otp-box.is-full{border-color:var(--acc,var(--sk-accent,#71ff00));}',
    '.sk-otp-box[aria-invalid="true"],.sk-otp-box.is-error{border-color:#ff3d3d;box-shadow:0 0 0 3px rgba(255,61,61,.12);}',
    '.sk-otp-box:disabled{opacity:.5;}',
    '@media (max-width:380px){.sk-otp-boxes{gap:6px;}}',

    /* ── CINEMATIC ORBIT ──────────────────────────────────────────────────────
       Four motion layers, and one hard engineering rule underneath all of them.

         LAYER 1  the SOKONI mark      stationary; pulses only on success
         LAYER 2  the verification ring breathes, then closes on success
         LAYER 3  the six digits        orbit, each staying upright
         LAYER 4  atmosphere            very slow light, barely noticed

       THE RULE: every PER-FRAME animation is `transform` or `opacity` and
       nothing else. Those two are composited on the GPU; width, top, box-shadow,
       filter and background-position are not, and animating them repaints the
       layer on the main thread every frame. A verification screen that stutters
       on an entry-level Android is worse than six plain boxes, so paint-heavy
       properties are used ONLY on discrete state changes — once, not per frame.

       will-change is declared on the three moving layers and nowhere else: it
       promotes a layer, and promoting everything exhausts memory on cheap
       devices, which is the failure it is meant to prevent. */
    /* THE RADIUS MUST NOT BE A PERCENTAGE.
       --sk-orb-r is consumed inside translateY(), and a percentage there resolves
       against THE TRANSFORMED ELEMENT — the 44px slot — not against the orbit.
       calc(50% - 26px) therefore computed 22px - 26px = -4px, and the negation
       put all six digits 4px BELOW the centre, stacked behind the mark, which
       has the higher z-index. That is why the digits did not appear to orbit:
       they were not on the circle at all. Measured, r=4px on every slot.
       The size is now a variable and the radius is derived from it in absolute
       units, so the same expression cannot be re-resolved against a child. */
    '.sk-otp-orb{position:relative;--sk-orb-size:min(74vw,300px);',
    '  width:var(--sk-orb-size);aspect-ratio:1;margin:6px auto 2px;',
    '  --sk-orb-r:calc(var(--sk-orb-size) / 2 - 26px);',
    '  --sk-orb-spin:11s;--sk-orb-ease:cubic-bezier(.22,.61,.36,1);',
    '  isolation:isolate;}',

    /* LAYER 4 — atmosphere. Two offset radial washes drifting at different rates,
       so the light never repeats visibly. transform + opacity only. */
    '.sk-otp-orb-atm{position:absolute;inset:-14%;border-radius:50%;pointer-events:none;z-index:0;',
    '  background:radial-gradient(circle at 32% 28%,rgba(113,255,0,.16),transparent 58%),',
    '  radial-gradient(circle at 70% 72%,rgba(120,190,255,.13),transparent 60%);',
    '  will-change:transform,opacity;animation:skOrbDrift 19s ease-in-out infinite;}',
    '@keyframes skOrbDrift{0%,100%{transform:translate3d(-2%,1%,0) scale(1);opacity:.55}',
    '  50%{transform:translate3d(2%,-2%,0) scale(1.06);opacity:.85}}',

    /* LAYER 2 — the verification ring. A thin breathing circle; the border is
       static and only the SCALE animates, so it never repaints. */
    '.sk-otp-orb-ring2{position:absolute;inset:6%;border-radius:50%;pointer-events:none;z-index:1;',
    '  border:1px solid rgba(113,255,0,.22);will-change:transform,opacity;',
    '  animation:skOrbBreathe 4.6s ease-in-out infinite;}',
    '@keyframes skOrbBreathe{0%,100%{transform:scale(1);opacity:.45}',
    '  50%{transform:scale(1.035);opacity:.8}}',

    /* The travelling light. A single dot carried by a rotating container — the
       cheapest possible way to move light around a circumference. */
    '.sk-otp-orb-sweep{position:absolute;inset:6%;border-radius:50%;pointer-events:none;z-index:1;',
    '  opacity:0;will-change:transform,opacity;animation:skOrbSweep 2.4s linear infinite;}',
    '.sk-otp-orb-sweep::before{content:"";position:absolute;top:-3px;left:50%;width:6px;height:6px;',
    '  margin-left:-3px;border-radius:50%;background:var(--acc,#71ff00);',
    '  box-shadow:0 0 10px 2px rgba(113,255,0,.6);}',
    /* THE TRAIL. A conic gradient fading to nothing BEHIND the dot, masked
       down to the ring's own thickness. It is a STATIC paint carried by the
       same rotating container as the dot, so the trail costs one
       rasterisation and then rides the compositor — where an animated
       gradient or a stroke-dashoffset repaints the full circle every frame.

       @supports-guarded deliberately: without mask the conic would fill the
       whole disc and cover the mark. No trail is a fine outcome on an old
       browser; a green disc over the SOKONI logo is not. */
    '@supports ((mask:radial-gradient(#000,#000)) or (-webkit-mask:radial-gradient(#000,#000))){',
    '.sk-otp-orb-sweep::after{content:"";position:absolute;inset:-1px;border-radius:50%;',
    '  background:conic-gradient(rgba(113,255,0,0) 0deg,rgba(113,255,0,.04) 200deg,',
    '    rgba(113,255,0,.26) 318deg,rgba(113,255,0,.6) 356deg,rgba(113,255,0,0) 360deg);',
    '  -webkit-mask:radial-gradient(closest-side,transparent calc(100% - 3px),#000 calc(100% - 3px));',
    '  mask:radial-gradient(closest-side,transparent calc(100% - 3px),#000 calc(100% - 3px));}',
    '}',
    '@keyframes skOrbSweep{to{transform:rotate(360deg)}}',

    /* PARTICLE ACCENTS — layer 4b. Six specks on ONE slowly COUNTER-rotating
       container: counter-rotating, so they drift against the digits and give
       the field parallax rather than a second thing spinning the same way.
       One transform animation for all six, plus an opacity twinkle each,
       which the compositor handles without touching the main thread.

       Each speck is a full-size rotated box whose ::before sits --r down from
       the centre. Rotating a 3px dot and translating it by a PERCENTAGE would
       resolve that percentage against the dot's own 3px, not against the
       orbit — the reason the obvious version of this does not work. */
    '.sk-otp-orb-dust{position:absolute;inset:0;z-index:1;pointer-events:none;',
    '  animation:skOrbSpin 34s linear infinite reverse;}',
    '.sk-otp-orb-dust b{position:absolute;inset:0;transform:rotate(var(--a));}',
    '.sk-otp-orb-dust b::before{content:"";position:absolute;top:var(--r);left:50%;',
    '  width:3px;height:3px;margin-left:-1.5px;border-radius:50%;',
    '  background:var(--acc,#71ff00);opacity:.18;',
    '  animation:skOrbTwinkle var(--t) ease-in-out infinite alternate;}',
    '@keyframes skOrbTwinkle{from{opacity:.10}to{opacity:.55}}',

    /* LAYER 1 — the mark. Never rotates. The glass frame is a static backdrop
       filter-free surface; only scale animates, and only on success. */
    '.sk-otp-orb-logo{position:absolute;left:50%;top:50%;width:38%;aspect-ratio:1;',
    '  transform:translate3d(-50%,-50%,0);border-radius:50%;overflow:hidden;z-index:3;',
    '  background:var(--sk-otp-logo-bg,#fff);display:grid;place-items:center;',
    '  border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.34);}',
    '.sk-otp-orb-logo img{width:82%;height:82%;object-fit:contain;display:block;}',
    /* Pulse is a CHILD scale, so the parent keeps its centring translate and the
       two transforms cannot fight. */
    '.sk-otp-orb-pulse{position:absolute;inset:0;border-radius:50%;pointer-events:none;',
    '  box-shadow:0 0 0 0 rgba(113,255,0,.55);opacity:0;}',

    /* LAYER 3 — the digits. */
    '.sk-otp-orb-ring{position:absolute;inset:0;z-index:2;will-change:transform;',
    '  animation:skOrbSpin var(--sk-orb-spin) linear infinite;}',
    '.sk-otp-orb-slot{position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;',
    '  transform:rotate(calc(var(--i) * 60deg)) translateY(calc(-1 * var(--sk-orb-r)));}',
    /* DEPTH. A flat ring reads as a spinner; a ring with depth reads as an
       orbit. Each digit scales and dims according to WHERE IT IS on the
       circle — largest and brightest at the bottom (nearest the viewer),
       smallest and faintest at the top (far side).

       The phase is not scripted. The depth cycle runs at exactly the spin
       duration and each slot takes a NEGATIVE delay of i/6 of it, which
       starts every digit at the point in the cycle its own orbital angle
       has already reached. So it stays locked to the rotation for free, and
       re-locks itself when --sk-orb-spin drops to 3.4s on acceleration.

       The rotate is repeated in every keyframe on purpose: transform is ONE
       property, so a keyframe setting only scale would DISCARD the counter-
       rotation and the digits would tumble. */
    '.sk-otp-orb-up{width:100%;height:100%;',
    '  transform:rotate(calc(-1 * var(--i) * 60deg));',
    '  animation:skOrbDepth var(--sk-orb-spin) linear infinite;',
    '  animation-delay:calc(var(--sk-orb-spin) * var(--i) / -6);}',
    '@keyframes skOrbDepth{',
    '  0%,100%{transform:rotate(calc(-1 * var(--i) * 60deg)) scale(.84);opacity:.55}',
    '  50%{transform:rotate(calc(-1 * var(--i) * 60deg)) scale(1.12);opacity:1}}',
    '.sk-otp-orb-d{position:relative;width:100%;height:100%;display:grid;place-items:center;border-radius:50%;',
    '  border:1.5px solid var(--line,rgba(255,255,255,.16));background:var(--sk-otp-slot-bg,rgba(255,255,255,.05));',
    '  font:900 19px/1 system-ui,-apple-system,sans-serif;color:var(--acc,var(--sk-accent,#71ff00));',
    '  will-change:transform;animation:skOrbSpin var(--sk-orb-spin) linear infinite reverse;}',
    '.sk-otp-orb-d.is-empty{color:transparent;background:var(--sk-otp-slot-bg,rgba(255,255,255,.035));}',
    '.sk-otp-orb-d.is-empty::after{content:"";width:5px;height:5px;border-radius:50%;',
    '  background:var(--txt3,rgba(255,255,255,.26));}',
    '.sk-otp-orb-d.is-full{border-color:var(--acc,var(--sk-accent,#71ff00));background:rgba(113,255,0,.10);}',
    /* MATERIALISE — a digit arrives rather than appearing. The inner span scales
       and fades; the slot itself is untouched so the orbit geometry is unaffected. */
    '.sk-otp-orb-v{display:block;transform:scale(1);opacity:1;}',
    '.sk-otp-orb-d.is-arriving .sk-otp-orb-v{animation:skOrbArrive .42s var(--sk-orb-ease) both;}',
    '@keyframes skOrbArrive{0%{transform:scale(.35);opacity:0}',
    '  55%{transform:scale(1.18);opacity:1}100%{transform:scale(1);opacity:1}}',
    /* "Each digit can briefly illuminate as it arrives." A halo expands and
       fades once. The gradient is transparent through the MIDDLE, so the
       light blooms AROUND the numeral instead of washing it out. Painted
       once into a layer; only transform and opacity animate. */
    '.sk-otp-orb-d::before{content:"";position:absolute;inset:-7px;border-radius:50%;',
    '  background:radial-gradient(circle,transparent 38%,rgba(113,255,0,.5) 62%,transparent 78%);',
    '  opacity:0;transform:scale(.55);pointer-events:none;}',
    '.sk-otp-orb-d.is-arriving::before{animation:skOrbFlash .55s var(--sk-orb-ease) both;}',
    '@keyframes skOrbFlash{0%{opacity:0;transform:scale(.55)}',
    '  28%{opacity:.95;transform:scale(1.04)}100%{opacity:0;transform:scale(1.3)}}',
    '@keyframes skOrbSpin{to{transform:rotate(360deg)}}',

    /* ── STATE: VERIFYING ── the orbit accelerates, the sweep appears. */
    '.sk-otp-orb.is-verifying{--sk-orb-spin:3.4s;}',
    '.sk-otp-orb.is-verifying .sk-otp-orb-sweep{opacity:1;}',
    '.sk-otp-orb.is-verifying .sk-otp-orb-ring2{animation-duration:1.6s;}',
    /* The held beat before acceleration — the orbit pauses, the digits align. */
    '.sk-otp-orb.is-aligning .sk-otp-orb-ring,',
    '.sk-otp-orb.is-aligning .sk-otp-orb-up,',
    '.sk-otp-orb.is-aligning .sk-otp-orb-d{animation-play-state:paused;}',
    '.sk-otp-orb.is-aligning .sk-otp-orb-pulse{animation:skOrbPulse .6s ease-out;}',
    '@keyframes skOrbPulse{0%{opacity:.9;box-shadow:0 0 0 0 rgba(113,255,0,.5)}',
    '  100%{opacity:0;box-shadow:0 0 0 22px rgba(113,255,0,0)}}',

    /* ── STATE: VERIFIED ── orbit settles, ring closes, mark pulses once. */
    /* SLOWING, NOT STOPPING. animation-play-state:paused freezes mid-turn — the
       single cheapest-looking thing an animation can do. On success the ring and
       every digit switch to a one-shot GLIDE: JS reads the angle they are
       actually at, pins them there, then eases them a further ~70deg to rest.
       Nothing jumps, because the glide starts from the live angle. */
    '.sk-otp-orb.is-settling .sk-otp-orb-ring,',
    '.sk-otp-orb.is-settling .sk-otp-orb-d{animation:none;',
    '  transition:transform 1.15s cubic-bezier(.14,.78,.32,1);}',
    /* The digits CONVERGE as it settles: each slot eases a little toward the
       mark, so the ring visibly gathers rather than simply halting. */
    '.sk-otp-orb.is-settling .sk-otp-orb-slot{transition:transform 1.15s cubic-bezier(.14,.78,.32,1);',
    '  transform:rotate(calc(var(--i) * 60deg)) translateY(calc(-1 * var(--sk-orb-r) + 7px));}',
    /* Depth RESOLVES as it settles: dropping the animation returns every digit
       to the static rule — scale 1, full opacity — so the six come to rest at
       EQUAL presence instead of freezing one big and one faint. */
    '.sk-otp-orb.is-settling .sk-otp-orb-up{animation:none;',
    '  transition:transform 1.15s cubic-bezier(.14,.78,.32,1),opacity .7s ease;}',
    '.sk-otp-orb.is-verified .sk-otp-orb-sweep{opacity:0;}',
    '.sk-otp-orb.is-verified .sk-otp-orb-d{border-color:var(--acc,#71ff00);background:rgba(113,255,0,.16);}',
    '.sk-otp-orb.is-verified .sk-otp-orb-pulse{animation:skOrbPulse .7s ease-out;}',
    /* The closing ring: two halves rotating to meet. Composited, where an
       animated stroke-dashoffset or conic-gradient would repaint every frame. */
    '.sk-otp-orb-close{position:absolute;inset:6%;border-radius:50%;pointer-events:none;z-index:4;',
    '  opacity:0;}',
    '.sk-otp-orb-close i{position:absolute;inset:0;border-radius:50%;',
    '  border:2px solid var(--acc,#71ff00);clip-path:inset(0 50% 0 0);',
    '  transform:rotate(180deg);will-change:transform;}',
    '.sk-otp-orb-close i+i{transform:rotate(-180deg);clip-path:inset(0 0 0 50%);}',
    '.sk-otp-orb.is-verified .sk-otp-orb-close{opacity:1;}',
    '.sk-otp-orb.is-verified .sk-otp-orb-close i{animation:skOrbCloseA .6s var(--sk-orb-ease) forwards;}',
    '.sk-otp-orb.is-verified .sk-otp-orb-close i+i{animation:skOrbCloseB .6s var(--sk-orb-ease) forwards;}',
    '@keyframes skOrbCloseA{to{transform:rotate(0deg)}}',
    '@keyframes skOrbCloseB{to{transform:rotate(0deg)}}',
    /* The tick sits BELOW the mark, as specified — not over it. Centred, it was
       a green glyph on top of the green basket in the logo: present, opacity 1,
       and invisible. The offset is derived from --sk-orb-size because a
       PERCENTAGE inside translate resolves against the 22px glyph itself. */
    '.sk-otp-orb-tick{position:absolute;left:50%;top:50%;z-index:5;opacity:0;',
    /* .25 of the orbit, at 26px: the only gap that clears BOTH the mark above
       and the bottom digit below. At .27/30px the glyph grazed the digit. */
    '  --sk-tick-drop:calc(var(--sk-orb-size) * .25);',
    '  transform:translate3d(-50%,calc(-50% + var(--sk-tick-drop)),0) scale(.6);',
    '  font:900 26px/1 system-ui,sans-serif;color:var(--acc,#71ff00);',
    '  text-shadow:0 2px 12px rgba(0,0,0,.5);pointer-events:none;}',
    '.sk-otp-orb.is-verified .sk-otp-orb-tick{animation:skOrbTick .5s var(--sk-orb-ease) .35s forwards;}',
    '@keyframes skOrbTick{to{opacity:1;',
    '  transform:translate3d(-50%,calc(-50% + var(--sk-tick-drop)),0) scale(1)}}',

    '.sk-otp-orb.is-error .sk-otp-orb-d{border-color:#ff3d3d;background:rgba(255,61,61,.10);}',
    '.sk-otp-orb.is-error .sk-otp-orb-ring2{border-color:rgba(255,61,61,.4);}',

    /* The real field: over everything, invisible, still focusable. display:none or
       visibility:hidden would take it out of iOS autofill and off the a11y tree. */
    '.sk-otp-orb-field{position:absolute;inset:0;width:100%;height:100%;opacity:0;z-index:6;',
    '  border:none;background:none;color:transparent;caret-color:transparent;',
    '  text-align:center;cursor:pointer;}',
    '.sk-otp-orb-field:focus{outline:none;}',

    '@media (max-width:360px){.sk-otp-orb{--sk-orb-size:min(84vw,268px);',
    '  --sk-orb-r:calc(var(--sk-orb-size) / 2 - 23px);}',
    '  .sk-otp-orb-slot{width:38px;height:38px;margin:-19px 0 0 -19px;}',
    '  .sk-otp-orb-d{font-size:17px;}}',

    /* Reduced motion: the composition stays, the movement stops. Not a degraded
       screen — a still one. */
    '@media (prefers-reduced-motion:reduce){',
    '  .sk-otp-orb-ring,.sk-otp-orb-d,.sk-otp-orb-atm,.sk-otp-orb-ring2,.sk-otp-orb-sweep,',
    '  .sk-otp-orb-up,.sk-otp-orb-dust,.sk-otp-orb-dust b::before,.sk-otp-orb-d::before,',
    '  .sk-otp-orb-close i,.sk-otp-orb-tick,.sk-otp-orb-pulse{animation:none!important;}',
    '  .sk-otp-orb-tick{opacity:1;',
    '    transform:translate3d(-50%,calc(-50% + var(--sk-tick-drop)),0) scale(1);}',
    '  .sk-otp-orb.is-verified .sk-otp-orb-close{opacity:1;}',
    '  .sk-otp-orb-close i{transform:rotate(0deg);}}',
  ].join('');

  function injectCss() {
    if (document.getElementById('sk-otp-css')) return;
    var s = document.createElement('style');
    s.id = 'sk-otp-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var _seq = 0;

  function mount(target, opts) {
    opts = opts || {};
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) return null;

    injectCss();

    var len   = opts.length || 6;
    var id    = opts.id || ('sk-otp-' + (++_seq));

    /* 6-box grid mode: individual digit inputs with auto-advance, backspace nav,
       paste distribution, and iOS AutoFill compat. */
    if (opts.boxes) return mountBoxes(host, opts, len, id);

    var hintId = id + '-hint';

    var wrap = document.createElement('div');
    wrap.className = 'sk-otp';

    var input = document.createElement('input');
    input.id = id;
    input.className = 'sk-otp-in';
    /* type=text, NOT number: type=number ignores maxlength, offers a spinner, and on
       several Android keyboards suppresses the SMS suggestion strip entirely. */
    input.type = 'text';
    input.inputMode = 'numeric';
    input.setAttribute('pattern', '[0-9]*');
    /* The two attributes that make one-tap autofill work. iOS reads one-time-code;
       Android/Gboard reads the same token to offer the code above the keyboard. */
    input.autocomplete = 'one-time-code';
    input.name = opts.name || 'one-time-code';
    input.maxLength = len;
    input.placeholder = opts.placeholder || (len + '-digit verification code');
    input.setAttribute('aria-label', opts.label || 'Verification code');
    input.setAttribute('aria-describedby', hintId);
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('autocorrect', 'off');
    input.spellcheck = false;
    input.enterKeyHint = 'go';

    var hint = document.createElement('p');
    hint.className = 'sk-otp-hint';
    hint.id = hintId;
    hint.textContent = opts.hint || 'Paste the code, or tap the suggestion above your keyboard.';
    /* Announce "code complete" / errors without stealing focus from the field. */
    hint.setAttribute('aria-live', 'polite');

    /* The only declaration a stylesheet !important cannot beat. See the note on the
       zoom-guard rules above. Reads --sk-otp-fs so the media query still drives it. */
    input.style.setProperty('font-size', 'var(--sk-otp-fs, 24px)', 'important');

    /* ── ORBIT MODE ───────────────────────────────────────────────────────────
       Opt-in per mount. The SOKONI mark sits at the centre and the six digits
       orbit it; the single input is laid over the whole thing, transparent, so
       autofill / paste / the keyboard suggestion behave exactly as before. The
       orbit only ever REFLECTS what that one field holds — it is a display, and
       six real inputs here would put back the defect this component removed. */
    var orb = null, slots = [];
    if (opts.orbit) {
      orb = document.createElement('div');
      orb.className = 'sk-otp-orb';

      var ring = document.createElement('div');
      ring.className = 'sk-otp-orb-ring';
      for (var oi = 0; oi < len; oi++) {
        var slot = document.createElement('div');
        slot.className = 'sk-otp-orb-slot';
        slot.style.setProperty('--i', String(oi));
        var up = document.createElement('div');
        up.className = 'sk-otp-orb-up';
        up.style.setProperty('--i', String(oi));
        var dig = document.createElement('div');
        dig.className = 'sk-otp-orb-d is-empty';
        /* The orbit is decorative; the INPUT carries the accessible value, so a
           screen reader is not read six floating digits as separate content. */
        dig.setAttribute('aria-hidden', 'true');
        up.appendChild(dig); slot.appendChild(up); ring.appendChild(slot);
        slots.push(dig);
      }

      var logo = document.createElement('div');
      logo.className = 'sk-otp-orb-logo';
      var img = document.createElement('img');
      img.alt = '';                       /* decorative — the label carries meaning */
      img.setAttribute('aria-hidden', 'true');
      img.src = opts.logo || '/assets/logosokoni.png';
      /* Tell the browser the intrinsic size so the circle does not reflow when
         the image lands, and let it decode off the main thread. */
      img.width = 512; img.height = 512;
      img.decoding = 'async';
      /* A missing asset must not leave a white hole where the mark should be. */
      img.onerror = function () { logo.style.display = 'none'; };
      logo.appendChild(img);
      var pulse = document.createElement('div');
      pulse.className = 'sk-otp-orb-pulse';
      logo.appendChild(pulse);

      /* The four layers, back to front. Every one of them is aria-hidden: the
         INPUT carries the accessible value, and a screen reader should not be
         read six floating digits, a tick and an atmosphere as content. */
      function layer(cls, html) {
        var el = document.createElement('div');
        el.className = cls;
        el.setAttribute('aria-hidden', 'true');
        if (html) el.innerHTML = html;
        return el;
      }
      orb.appendChild(layer('sk-otp-orb-atm'));        /* 4 — atmosphere      */
      /* 4b — light accents. Angles and radii are deliberately irregular and
         the twinkle periods share no common factor, so the field never
         visibly repeats. */
      var DUST = [[18, '27%', '5.1s'], [74, '41%', '7.3s'], [142, '33%', '4.4s'],
                  [221, '44%', '8.2s'], [298, '24%', '6.1s'], [335, '38%', '9.4s']];
      orb.appendChild(layer('sk-otp-orb-dust', DUST.map(function (d) {
        return '<b style=\'--a:' + d[0] + 'deg;--r:' + d[1] + ';--t:' + d[2] + '\'></b>';
      }).join('')));
      orb.appendChild(layer('sk-otp-orb-ring2'));      /* 2 — breathing ring  */
      orb.appendChild(layer('sk-otp-orb-sweep'));      /* 2 — travelling light*/
      orb.appendChild(ring);                            /* 3 — the digits      */
      orb.appendChild(logo);                            /* 1 — the mark        */
      orb.appendChild(layer('sk-otp-orb-close', '<i></i><i></i>'));
      var tick = layer('sk-otp-orb-tick');
      tick.textContent = '✓';
      orb.appendChild(tick);
      input.classList.add('sk-otp-orb-field');
      orb.appendChild(input);
      wrap.appendChild(orb);
    } else {
      wrap.appendChild(input);
    }
    wrap.appendChild(hint);
    host.innerHTML = '';
    host.appendChild(wrap);

    /* Paint the ring from the ONE field. Called on every input event, so the
       orbit can never disagree with the value that will actually be submitted. */
    /* MATERIALISE, don't just appear. A digit that is NEW since the last paint
       gets the arrival animation; one that was already there is left alone, so a
       backspace-and-retype does not re-animate the whole ring. An autofill lands
       all six at once, and they are staggered so they arrive in sequence rather
       than flashing together. */
    /* Read where the ring ACTUALLY is, pin it there, then glide it to rest.
       Reading the live angle is what stops the transition snapping back to 0deg
       before it eases — the ring is mid-rotation when success arrives, and CSS
       has no idea where an infinite animation had got to. */
    function angleOf(el) {
      var t = getComputedStyle(el).transform;
      if (!t || t === 'none') return 0;
      var m = new DOMMatrix(t);
      return Math.atan2(m.b, m.a) * 180 / Math.PI;
    }
    function settleOrbit() {
      if (!orb || !ring) return;
      var a = angleOf(ring);
      var digitAngles = slots.map(angleOf);
      /* Pin at the live angle with animations still running, THEN cut them. */
      ring.style.transform = 'rotate(' + a + 'deg)';
      slots.forEach(function (d, i) { d.style.transform = 'rotate(' + digitAngles[i] + 'deg)'; });
      orb.classList.add('is-settling');
      void orb.offsetWidth;                 /* commit the pinned angle first */
      /* A further 70deg, eased — the ring coasts to a stop. Digits counter-turn
         by the same amount so they stay upright the whole way down. */
      ring.style.transform = 'rotate(' + (a + 70) + 'deg)';
      slots.forEach(function (d, i) { d.style.transform = 'rotate(' + (digitAngles[i] - 70) + 'deg)'; });
    }

    var shownDigits = '';
    var alignT = null;
    function paintOrbit() {
      if (!orb) return;
      var v = input.value || '';
      var arrivals = 0;
      for (var k = 0; k < slots.length; k++) {
        var ch = v.charAt(k);
        var was = shownDigits.charAt(k);
        var d = slots[k];
        if (ch === was) continue;                    /* unchanged — leave it be */

        /* One span inside the cell carries the scale, so the cell's own layout
           and the orbit geometry are never touched by the animation. */
        d.innerHTML = ch ? '<span class="sk-otp-orb-v">' + ch + '</span>' : '';
        d.classList.toggle('is-empty', !ch);
        d.classList.toggle('is-full', !!ch);
        d.classList.remove('is-arriving');
        if (ch) {
          /* Restart the animation reliably: reading offsetWidth forces the class
             removal to take effect before it is re-added. */
          void d.offsetWidth;
          var delay = arrivals * 70;
          arrivals++;
          if (delay) {
            (function (el, ms) { setTimeout(function () { el.classList.add('is-arriving'); }, ms); })(d, delay);
          } else d.classList.add('is-arriving');
        }
      }
      shownDigits = v;
    }

    var fired = false;          /* onComplete fires once per distinct full code */
    var lastFired = '';
    var ac = null;              /* WebOTP AbortController */

    function sanitize(raw) {
      /* Strips spaces, dashes, invisible characters and anything a paste drags in
         ("Your code is 899297" → "899297"). */
      return String(raw || '').replace(/\D+/g, '').slice(0, len);
    }

    function maybeComplete() {
      var v = input.value;
      if (v.length !== len) { fired = false; return; }
      if (fired && v === lastFired) return;   /* autofill + input can both land */
      fired = true;
      lastFired = v;
      if (typeof opts.onComplete === 'function') {
        /* A tick of breathing room so the user SEES the code land in the field
           before the button flips to "Verifying…". Instant submit reads as a glitch. */
        setTimeout(function () { opts.onComplete(v); }, 120);
      }
    }

    function onInput() {
      var clean = sanitize(input.value);
      if (clean !== input.value) {
        /* Rewriting .value resets the caret to the end, which is exactly where it
           belongs after we drop a non-digit — but only touch it when we changed
           something, or we'd break mid-string Backspace editing. */
        input.value = clean;
      }
      input.classList.toggle('is-full', clean.length === len);
      if (clean.length < len) input.setAttribute('aria-invalid', 'false');
      /* The ring follows the FIELD, on every keystroke and every autofill, so the
         two can never disagree about what will be submitted. */
      paintOrbit();
      if (orb && clean.length < len) orb.classList.remove('is-error');
      maybeComplete();
    }

    input.addEventListener('input', onInput);

    /* Safari fires neither `input` nor `change` reliably for AutoFill on every iOS
       version; `change` on blur is the belt to `input`'s braces. */
    input.addEventListener('change', onInput);

    /* Enter submits — the keyboard's "go" key should do the obvious thing. */
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (input.value.length === len && typeof opts.onComplete === 'function') {
          fired = true; lastFired = input.value;
          opts.onComplete(input.value);
        }
      }
    });

    /* ── WebOTP (Android Chrome) ───────────────────────────────────────────────
       Progressive enhancement. It only fires when the SMS body ends with the
       origin-bound line "@host #code" — Firebase's phone-auth template does NOT
       currently include it, so this is a no-op today and stays one until the SMS
       template changes. Wiring it now costs nothing (feature-detected, aborted on
       destroy) and means the day the template gains the suffix, one-tap works with
       no further client change. The keyboard-suggestion path above works regardless. */
    if ('OTPCredential' in global && global.isSecureContext) {
      try {
        ac = new AbortController();
        navigator.credentials.get({ otp: { transport: ['sms'] }, signal: ac.signal })
          .then(function (otp) {
            if (!otp || !otp.code) return;
            input.value = sanitize(otp.code);
            onInput();
          })
          .catch(function () { /* aborted, unsupported, or user dismissed — ignore */ });
      } catch (e) { /* no-op */ }
    }

    var api = {
      el: input,
      value: function () { return input.value; },
      focus: function () { try { input.focus(); } catch (e) {} return api; },
      clear: function () {
        input.value = '';
        input.classList.remove('is-full');
        input.setAttribute('aria-invalid', 'false');
        fired = false; lastFired = '';
        clearTimeout(alignT);
        /* shownDigits is NOT reset here. paintOrbit() diffs the new value against
           it and skips cells that did not change; zeroing it first makes every
           cell look unchanged ('' === ''), so the ring kept displaying the old
           code after clear(). paintOrbit sets it at the end, which is the only
           place that should. */
        paintOrbit();
        if (orb) {
          /* is-settling MUST be cleared too, and the inline angles with it. It
             sets animation:none, so a clear() that left it behind froze the orbit
             permanently — a wrong code followed by a resend would show a dead
             ring. The compositing control caught exactly this: only 3 of 5 layers
             were still animating afterwards. */
          orb.classList.remove('is-error','is-verifying','is-verified','is-aligning','is-settling');
          if (ring) ring.style.transform = '';
          slots.forEach(function (d) { d.style.transform = ''; });
        }
        return api;
      },
      /* WAITING -> ENTERING -> VERIFYING -> VERIFIED, as the caller knows them.
         The component owns no network call, so it cannot know which state it is
         in; the page that does the verifying says so. An unknown name is ignored
         rather than guessed at. */
      /* waiting → entering → verifying → verified.
         The component owns no network call, so it cannot know which state it is
         in; the page doing the verifying says so. An unknown name is ignored
         rather than guessed at.

         VERIFYING IS A TWO-BEAT MOVE, and the beat is the point. The orbit HOLDS
         for ~380ms with the digits aligned and the mark pulsing once, and only
         then accelerates and releases the travelling light. Going straight to
         fast reads as a spinner; the held beat is what makes it read as a
         decision being taken. */
      /* Announces every transition through opts.onState, so a page can move its
         own copy (VERIFY YOUR NUMBER -> VERIFYING -> VERIFIED) without keeping a
         second copy of the state machine and drifting out of step with it. */
      state: function (name) {
        try { if (typeof opts.onState === 'function') opts.onState(name || 'waiting'); } catch (_) {}
        if (!orb) return api;
        clearTimeout(alignT);
        orb.classList.remove('is-verifying', 'is-verified', 'is-aligning');
        if (name === 'verifying') {
          orb.classList.add('is-aligning');
          alignT = setTimeout(function () {
            orb.classList.remove('is-aligning');
            orb.classList.add('is-verifying');
          }, 380);
        } else if (name === 'verified') {
          settleOrbit();
          orb.classList.add('is-verified');
        } else {
          orb.classList.remove('is-settling');
          if (ring) ring.style.transform = '';
          slots.forEach(function (d) { d.style.transform = ''; });
        }
        return api;
      },
      disabled: function (on) { input.disabled = !!on; return api; },
      error: function (on) {
        input.setAttribute('aria-invalid', on ? 'true' : 'false');
        if (orb) { orb.classList.toggle('is-error', !!on);
                   if (on) { orb.classList.remove('is-verifying','is-verified','is-settling');
                             if (ring) ring.style.transform = '';
                             slots.forEach(function (d) { d.style.transform = ''; }); } }
        /* Re-arm: a wrong code must be able to auto-submit again once corrected. */
        if (on) { fired = false; lastFired = ''; }
        return api;
      },
      destroy: function () {
        if (ac) { try { ac.abort(); } catch (e) {} ac = null; }
        clearTimeout(alignT);
        return api;
      },
    };

    return api;
  }

  /* ── 6-box mode implementation ──────────────────────────────────────────────
     Six individual digit inputs. Each box handles its own input event and routes
     focus, paste, and backspace correctly.

     iOS AutoFill path: iOS offers the full 6-digit code to the box carrying
     autocomplete="one-time-code", and it RESPECTS that field's maxlength. This
     comment previously claimed AutoFill bypasses maxLength; it does not, and
     with maxLength=1 the OS delivered a single character, the value.length > 1
     branch below never ran, and one-tap autofill filled only the first digit.
     The first box therefore carries maxLength = len so the whole code can land;
     the input handler then distributes it across the boxes.

     Android keyboard suggestions route to autocomplete="one-time-code" on the first
     box; the same distribute() path handles it.

     The public API is identical to the single-field API so callers need no changes.
  ─────────────────────────────────────────────────────────────────────────────── */
  function mountBoxes(host, opts, len, id) {
    var wrap = document.createElement('div');
    wrap.className  = 'sk-otp-boxes';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', opts.label || 'Verification code');

    var inputs = [];
    for (var i = 0; i < len; i++) {
      var box = document.createElement('input');
      box.type      = 'text';
      box.inputMode = 'numeric';
      box.setAttribute('pattern', '[0-9]*');
      /* The FIRST box accepts the whole code; the rest accept one digit.
         iOS AutoFill respects maxlength — it does NOT bypass it, which is what
         the comment above this function assumed. With maxLength=1 the OS
         delivered exactly one character, the `v.length > 1` branch in the input
         handler never ran, distribute() never fired, and one-tap autofill filled
         only the first digit. Single-field mode never had the bug because it
         sets maxLength = len.
         Typing is unaffected: one typed character takes the single-digit path
         and advances focus; more than one goes through distribute(), which is
         the correct behaviour for a fast typist or a keyboard suggestion. */
      box.maxLength = (i === 0) ? len : 1;
      box.className = 'sk-otp-box';
      box.setAttribute('aria-label', 'Digit ' + (i + 1) + ' of ' + len);
      /* Only the first box carries autocomplete="one-time-code": iOS/Android
         route the SMS suggestion to a SINGLE field; we distribute from there. */
      box.autocomplete = (i === 0) ? 'one-time-code' : 'off';
      if (i === 0) box.name = opts.name || 'one-time-code';
      box.setAttribute('autocapitalize', 'off');
      box.setAttribute('autocorrect', 'off');
      box.spellcheck    = false;
      box.enterKeyHint  = (i === len - 1) ? 'go' : 'next';
      /* Inline !important beats the global iOS-zoom guard (see single-field note). */
      box.style.setProperty('font-size', 'var(--sk-otp-box-fs, 22px)', 'important');
      inputs.push(box);
      wrap.appendChild(box);
    }

    var fired = false;
    var lastFired = '';

    function getValue() {
      return inputs.map(function(b) { return b.value; }).join('');
    }

    function distribute(str, startIdx) {
      /* Strip non-digits — handles "Your code is 899297", dashes, spaces, etc. */
      var digits = String(str || '').replace(/\D+/g, '').slice(0, len);
      var pos = startIdx || 0;
      for (var i = 0; i < digits.length && pos < len; i++, pos++) {
        inputs[pos].value = digits[i];
        inputs[pos].setAttribute('aria-invalid', 'false');
        inputs[pos].classList.remove('is-error');
      }
      /* Focus the first unfilled box, or the last box if all filled. */
      var focusIdx = pos < len ? pos : len - 1;
      try { inputs[focusIdx].focus(); } catch(e) {}
      maybeComplete();
    }

    function maybeComplete() {
      var v = getValue();
      if (v.length !== len) { fired = false; return; }
      if (fired && v === lastFired) return;
      fired = true;
      lastFired = v;
      inputs.forEach(function(b) { b.classList.add('is-full'); });
      if (typeof opts.onComplete === 'function') {
        setTimeout(function() { opts.onComplete(v); }, 120);
      }
    }

    inputs.forEach(function(box, idx) {
      box.addEventListener('input', function() {
        var v = box.value;
        /* The whole code arrived in one box — AutoFill, a keyboard suggestion, or
           a fast typist. Reachable only because box 0's maxLength is len, not 1. */
        if (v.length > 1) {
          box.value = '';
          distribute(v, idx === 0 ? 0 : idx);
          return;
        }
        var digit = v.replace(/\D/g, '');
        box.value = digit;
        if (digit) {
          box.setAttribute('aria-invalid', 'false');
          box.classList.remove('is-error');
          if (idx < len - 1) try { inputs[idx + 1].focus(); } catch(e) {}
          maybeComplete();
        }
      });

      box.addEventListener('keydown', function(e) {
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (box.value) {
            box.value = '';
            fired = false;
          } else if (idx > 0) {
            inputs[idx - 1].value = '';
            fired = false;
            try { inputs[idx - 1].focus(); } catch(e) {}
          }
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          e.preventDefault();
          try { inputs[idx - 1].focus(); } catch(e) {}
        } else if (e.key === 'ArrowRight' && idx < len - 1) {
          e.preventDefault();
          try { inputs[idx + 1].focus(); } catch(e) {}
        } else if (e.key === 'Enter' && idx === len - 1) {
          e.preventDefault();
          var v = getValue();
          if (v.length === len && typeof opts.onComplete === 'function') {
            fired = true; lastFired = v;
            opts.onComplete(v);
          }
        }
      });

      box.addEventListener('paste', function(e) {
        e.preventDefault();
        var pasted = (e.clipboardData || window.clipboardData || {}).getData('text');
        if (pasted) distribute(pasted, idx === 0 ? 0 : idx);
      });

      /* Select on focus: re-entering a digit is natural — tap the box, type. */
      box.addEventListener('focus', function() {
        try { box.select(); } catch(e) {}
      });
    });

    host.innerHTML = '';
    host.appendChild(wrap);

    var api = {
      el:    inputs[0] || null,
      value: function() { return getValue(); },
      focus: function() {
        var firstEmpty = null;
        for (var i = 0; i < inputs.length; i++) {
          if (!inputs[i].value) { firstEmpty = inputs[i]; break; }
        }
        try { (firstEmpty || inputs[0]).focus(); } catch(e) {}
        return api;
      },
      clear: function() {
        inputs.forEach(function(b) {
          b.value = '';
          b.classList.remove('is-full', 'is-error');
          b.setAttribute('aria-invalid', 'false');
        });
        fired = false; lastFired = '';
        return api;
      },
      disabled: function(on) {
        inputs.forEach(function(b) { b.disabled = !!on; });
        return api;
      },
      error: function(on) {
        inputs.forEach(function(b) {
          b.setAttribute('aria-invalid', on ? 'true' : 'false');
          b.classList.toggle('is-error', !!on);
        });
        if (on) { fired = false; lastFired = ''; }
        return api;
      },
      destroy: function() { return api; },
    };

    return api;
  }

  global.SokoniOtp = { mount: mount };
})(window);

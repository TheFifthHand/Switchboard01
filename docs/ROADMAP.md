# Omni Song — roadmap

This page says where Omni Song is going. Everything under **Plans** is a plan, not a promise: there
are no dates, and any of it may change, shrink or be dropped once it is tried. What exists today is
listed first, so the difference is clear.

## The idea

Omni Song started as SWITCHBOARD / 01, a browser music console. The owner's larger idea, called
**Omni Song / Interstitial Medium**, is music you move with your body: a song is something you can
step into and shape with gestures, not only with knobs and pads — a medium *between* the person,
the sound and the space around them. The steps below lead in that direction, one at a time, while
the app stays simple for someone who just wants to make a beat.

The rules that hold today keep holding: Omni Song runs on your own device, needs no account, sends
nothing anywhere and ships its sounds with the app. Any later feature that needs more (a local AI
model, a camera, a headset) is optional, stays on your machine and is off until you turn it on.

## What exists now (2.0)

- **Make music without theory:** Jump In plays a starter groove; eight parts by four rows of loops,
  Play / Pause / Stop, labelled Mute and Solo, drag-and-drop clips, Musical Assist keeps notes in key,
  Variation makes new takes on a pattern.
- **Sounds:** 15 drum kits and more than 60 synth sounds, all original synthesis, in a sound browser
  with categories and Preview; six big knobs per part (Tone, Space, Echo, Motion, Drive, Pump).
- **Simple and Advanced:** the essentials by default; every control (effects, cables, arpeggiator,
  key and scale) one switch away.
- **Mix and master:** a channel strip per part, mastering presets, loudness targets with live
  readings and Match target, a spectrum display and A/B.
- **Record and keep:** performance recording and replay, note recording, an arrangement view, WAV
  export rendered by the same engine, project files you can move between browsers, offline use.
- **Help:** a three-step quick guide and "Try this" hints that follow what you do.
- **New in 2.0:** MIDI keyboards and controllers (with MIDI learn), and recording your voice or an
  instrument in time with the music, with simple edits of the take.

## Plans

### 1. Songs from your own AI model, on your own computer

*Plan.* The owner runs **YuE2**, a song-generation model, locally. The idea is to let Omni Song ask
that model for a song idea and bring the result in as material to play with:

- A **small local bridge**: a separate helper program on the same computer that Omni Song talks to
  over the loopback address (`127.0.0.1`), the way the launcher already serves the app. Omni Song
  itself would still contain no AI and download nothing; without the bridge, nothing changes.
- **Importing generated stems**: the parts the model produces (drums, bass, vocals …) arrive as
  recordings on sampler parts, cut into clips at the song's tempo, so they can be muted, re-mixed,
  mastered and combined with Omni Song's own parts.
- Open questions: what the bridge's interface looks like, how long generation takes on ordinary
  hardware, how stems are aligned to bars, and how to label generated material clearly. The model's
  own licence and the rights to what it generates would need to be checked before anything ships.

### 2. Move to play: body and motion control through a webcam

*Plan.* In-browser **pose tracking** (for example MediaPipe's pose or hand landmarks, running
locally in the browser) would turn movement into music:

- Map movement to the **six big knobs** (macros): raise a hand for more Space, lean for Tone,
  move faster for more Motion; a gesture could launch a scene or mute a part.
- The camera image would be used only on the device, never stored or sent, and the camera would be
  off until turned on, with a clear on-screen sign while it is on.
- The audio clock stays the timing authority: gestures change sound settings smoothly, and anything
  that starts a clip still lands on the next bar.
- Open questions: latency and jitter of tracking on everyday laptops, how to avoid accidental
  changes, how to calibrate quickly, and how to make it accessible to people who move differently.

### 3. Step inside: WebXR for VR and AR headsets

*Plan.* With **WebXR**, the same app could open in a VR or AR headset's browser: pads and knobs as
objects around you, parts placed in space, hands as controllers. It would reuse the same engine and
project files, so a song made on a laptop opens in the headset and back.

- Open questions: which headsets and browsers support what is needed, comfort and text size in a
  headset, and how Simple mode translates to 3D.

### 4. Omni Song / Interstitial Medium

*Plan, and the long-term direction.* Bring the pieces together: generated material from your own
model, shaped by your movement, in a space you can stand in — music as something you move through.
What this becomes will be decided by trying the earlier steps first.

### 5. Smaller things deferred from round 4

*Plan.* Round 4 (the whole-app upgrade after 2.1) left these out on purpose, to be picked up later:

- **Stem export:** one WAV per part from the Export dialog.
- **Drum rolls** in the step grid.
- **Preview on each sound card** in the sound browser (today Preview plays the part's current
  sound).
- **Sampler:** slicing a recording, an ADSR envelope and more filter types.
- **Shape:** a per-voice drum strip, a voice-source picker, and saving your own sound presets.
- **Links to views** (hash routing), so a view can be bookmarked or reopened by address.

## How plans become features

Each plan starts as a small experiment behind an option, is measured against the same quality bar
as the rest of the app (it must change the real sound, work without a network, be accessible and be
tested in a real browser) and is described in [`OMNI_UX.md`](OMNI_UX.md) before it becomes part of
the app. Anything that cannot meet that bar stays an experiment.

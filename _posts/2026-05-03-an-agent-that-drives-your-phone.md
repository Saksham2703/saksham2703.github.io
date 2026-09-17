---
title: "An agent that drives your phone, built in a day"
description: "Orion reads the screen, asks a model running on the phone what to tap, and taps it. The model was the easy part. The loop around it was not."
reading: "7 min"
---

## What we built

At the Google × Qualcomm hackathon this spring, five of us built Orion: an agent that operates an Android phone the way a person does. You type a goal like "find the cheapest ride to SFO". It opens Uber, Lyft and Waymo one after another, types the destination, reads the fare off each screen, and shows you a ranked overlay. Tap a row and it finishes the booking in that app.

There are no integrations. No Uber API, no Lyft SDK. Orion only ever sees what's on the screen and taps what a thumb could tap. And the model doing the deciding runs on the phone itself, so nothing about your screen leaves the device.

The team wrote up the [project site](https://orionassistanthack.github.io/Orion/) with the demo video. This post is my side of it: the loop, and what broke.

## The loop

Every cycle does three things.

**See.** A foreground service captures the screen with MediaProjection, and the accessibility service walks the UI tree for every clickable node with a label. The screenshot and the node list both go to the model.

**Think.** The model is Gemma 4, the E4B variant, 4-bit quantized, running through Google's LiteRT-LM runtime. The prompt is the goal, the app package, the node list as a numbered table, and a strict JSON schema for the answer. It has to return exactly one action: tap a node by index, type text into a node, or "none" when the goal is done. Sampling is at temperature 0.2 so the JSON stays parseable.

**Act.** The accessibility service performs the click on the node. If the node won't take a click, it falls back to a tap gesture at the node's centre. Then the loop runs again.

A cycle takes somewhere between half a second and two and a half seconds depending on the phone. That is slow for a UI, but fast enough that watching it work is fun rather than painful.

## The NPU that wasn't

The plan was to run Gemma on the Hexagon NPU. The README still says so. The backend list in the first commits was NPU, then GPU, then CPU as fallbacks. We couldn't get the NPU path working reliably on our test phone in the time we had, so late on the first night I cut the list down to the GPU and moved on. The site says "no NPU required", which is the polite version.

I'd still like to know how much the NPU would have bought us, because latency was the thing that shaped every other decision.

## The model was fine. The loop was the problem.

Almost every bug I fixed over the 24 hours was the loop acting on a screen that wasn't the screen it thought it was looking at.

**Capturing too early.** After a tap, the next capture fired while the app was still animating in. The model would get a screenshot of a half-drawn screen with three nodes in it and confidently tap the wrong one. The fix was a stack of guards: a 2.5 second cooldown after every action before the next capture, a retry if the tree has fewer than five clickable nodes, a retry if the root window still belongs to a different package than the one we launched, and a retry if the node list is byte-for-byte identical to the one before the action. That last one has a cap, because a keyboard popping up changes the screen without changing the accessibility tree.

**Typing into a loop.** In the ride apps, after Orion typed the destination, the model would look at the new screen, see the destination field again, and tap it again. Forever. I fixed it with a shortcut I'm not proud of: after a successful type, skip the model entirely and tap the first node whose text contains the first word of what was typed. It's a hack, it's still in the code, and it made the demo work.

**Not knowing when to stop.** The model is told to answer "none" only on a final confirmation screen. It answered "none" on loading screens anyway. So a single "none" no longer ends the run. Three in a row do.

**Believing placeholders.** The fare extraction accepted "..." as a price, because that's what Uber shows while the estimate loads. Prices now have to contain a digit before they count.

**Letting the model see its own mistakes.** When the model picks a node index that isn't in the tree, the next prompt starts with a correction line saying exactly that, and that the valid nodes are the ones listed. Same when it tries to type with no keyboard visible. It's one sentence of context, and it turned a model that repeats its last wrong move into one that tries something else.

The keyboard was its own saga. We tried detecting it from the accessibility service, reverted that within the hour, and ended up asking the model itself: "do you see a QWERTY layout?" If it says no, typing is forbidden and it has to tap a field first. That's dumber than a real keyboard check and it worked better.

## Comparison mode

The ride comparison isn't special-cased in the loop. Each app is a data entry: package name, deep link scheme, whether its text fields accept a direct set-text call or need real keystrokes, and what its destination field is labelled. A small state machine opens the apps in turn, waits until the model's extracted data contains a real fare, records it, and moves to the next app. When every installed app has reported, the overlay ranks them by price or by ETA depending on whether you asked for "cheapest" or "fastest".

Adding a fourth app is one more entry in the list.

## What I'd do next

Every cycle currently sends the screenshot. Most of the time the node list alone is enough to pick the next tap, and the image is the expensive part of inference. The day after the hackathon I wrote a plan for a text-first pass that only escalates to the screenshot when the text-only answer isn't confident. It isn't built. It's the first thing I'd build.

One teammate spent part of the hackathon porting Qwen 2.5-VL to LiteRT-LM, with the export tooling, so a vision-language model would be an option on the same runtime. That work is at [Qwen-on-device](https://github.com/IamShubhamGupto/Qwen-on-device).

Orion was built by Aneesh Bhattacharya, Saksham Jain, Shubham Gupta, Prateek Sengar and Ajit Chourasia.

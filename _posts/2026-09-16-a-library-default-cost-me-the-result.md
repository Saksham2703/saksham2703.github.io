---
title: "A library default cost me the entire result"
description: "I trained an ACT policy on Push-T, evaluated it, and got 0%. The policy was fine. One inference-time setting was not."
reading: "6 min"
---

## The 0%

I trained an ACT policy on Push-T with LeRobot 0.4.4, ran the standard 50-episode eval, and got zero successes. Not a low number. Zero.

The diffusion policy I'd trained on the same data with the same budget got 30%, so the data and the training loop were fine. My first instinct was that ACT just didn't work at this budget, or that I'd broken something in the policy swap. I spent a while looking at loss curves. They looked normal.

Then I watched the eval videos. The arm was moving toward the T, pushing it in roughly the right direction, and then drifting. It wasn't failing to act. It was acting for too long without looking.

The setting was `n_action_steps`. ACT predicts a chunk of 100 future actions at once, and LeRobot's default is to execute all 100 of them open-loop before taking another observation. On Push-T, 100 steps is a third of the whole episode with your eyes closed. Any small error in the first few actions compounds through the rest of the chunk, and the policy never gets a chance to correct.

## Why I didn't retrain

This is the part I want to be clear about, because it's the reason the rest of the post exists. `n_action_steps` is an inference-time setting. It doesn't change the weights. The policy still predicts 100 actions; the setting only decides how many of them get executed before you ask again.

So I didn't retrain anything. I took the same checkpoint and re-ran the same eval at five different horizons. Each eval is 50 episodes and takes a few minutes on a rented A10. That's cheap enough to sweep properly rather than guess.

## The sweep

<p class="hint">Same checkpoint, same 50 seeds. Drag the slider to change the horizon.</p>

{% include pusht-figure.html %}

## What the curve says, and what it doesn't

The peak is at 20 actions. That's 34% on the same policy that scored 0% at the default. Nothing about the model changed.

Two things I'm careful about here. First, 50 episodes is a small sample. Binomial noise on a proportion near 0.3 at n=50 is about ±6.5 points, so 20 and 10 are not cleanly separated, and I wouldn't bet on 20 being the exact peak on a different set of seeds. What I would bet on is the shape: a horizon somewhere in the 10 to 30 range, and both ends of the sweep falling off hard.

Second, 34% beats the diffusion baseline's 30%, but by less than the noise. I'm not claiming ACT is better than diffusion here. I'm claiming it's comparable, which is a different sentence than the one I'd have written after the first eval.

And both policies got 250 epochs, which is about half the reference config's budget. I don't know what the curve looks like at 500.

## Temporal ensembling made it worse

The ACT paper's fix for the same problem is temporal ensembling. You execute one action at a time, but you predict a fresh chunk every step and average the overlapping predictions with an exponential weight. The intuition is that you get the smoothness of chunking with the responsiveness of replanning every step.

I tried it. Four coefficients, spanning a thousand-fold range.

| coefficient | success | near-miss |
|---|---|---|
| 0.0005 | 0 / 50 | 1 |
| 0.01 | 0 / 50 | 0 |
| 0.1 | 0 / 50 | 0 |
| 0.5 | 0 / 50 | 1 |

Flat zero across the whole range. It isn't a bad-hyperparameter problem, because there's no setting where it starts working. On this task, with this policy, plain periodic replanning at 20 steps beats ensembling at every coefficient I tried. I don't have a good explanation for that yet. My guess is that averaging predictions made from very different observations smears the push direction, on a task where the direction matters more than the smoothness. But that's a guess and I haven't tested it.

## The metric disagreed with my eyes

One more thing the videos taught me. Push-T counts an episode as a success only if the T ends up covering more than 95% of the target. That's strict. A lot of the "failed" episodes at the default setting had the T sitting almost exactly on the goal, a few degrees off.

So I bucketed every episode by its best coverage: success above 0.95, near-miss between 0.90 and 0.95, partial between 0.15 and 0.90, and no engagement below that. At the 100-step default, 3 of the 50 episodes were near-misses and 34 were partial. The policy had learned the task. It had not learned to finish it, because it never looked at what it had done.

That bucket column is the thing I'd want in every eval table now. A 0% that's mostly near-misses and a 0% that's mostly no-engagement are two different bugs, and the headline number can't tell them apart.

## The short version

If you swap policies in LeRobot and the new one scores zero, check `n_action_steps` before you check anything else. Executing the full chunk is a reasonable default for a real arm at 50 Hz, where the world barely changes in two seconds. It's a bad one for a 10 Hz sim task where the whole episode is 300 steps.

And sweep the inference-time settings before you touch training. They're free.

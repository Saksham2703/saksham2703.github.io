---
title: "A passing run that passed for the wrong reason"
description: "My data-starvation experiment worked. It shouldn't have. Finding out why it worked is what exposed the bug."
reading: "5 min"
---

## The crash

I was training a diffusion policy on half of the Push-T dataset. Not a random half. I'd split the 206 episodes at the median starting x-position of the pusher, to see how well a policy trained on one side of the workspace generalises to the other. That gave me a list of 103 episode numbers, scattered across the full range, and I passed it to LeRobot with `--dataset.episodes`.

It ran for a while and then died:

```
IndexError: Invalid key: 23503 is out of bounds for size 12727
```

Those two numbers told me most of the story before I'd read a line of code. My 103 episodes add up to 12,727 frames. The full dataset has 25,650. Something was asking for frame 23,503, which exists in the full dataset and not in mine.

## Reading the library instead of guessing

I'd been on LeRobot 0.4.4 for a few weeks by then, so I opened the installed source rather than the docs.

When you pass an episode list, the dataset filters its table down to those episodes' frames. From then on, indexing into it is positional. Row 0 is the first frame of the first selected episode, whatever that episode's number was.

The training script builds its sampler from a different place. It reads each episode's start and end frame out of the dataset metadata, and those are positions in the full, unfiltered table. So the sampler hands out absolute frame numbers, and the dataset treats them as positions in a table that is half the size.

The odd part is that the dataset already knew how to translate. At load time it builds a dictionary from absolute frame index to filtered position, and then nothing in the training path used it. The fix was sitting there, unplugged.

## The part that mattered

Before that I'd run a data-starvation experiment on the same setup: train on 20% of the episodes, same epoch budget, see how far the success rate falls. I picked episodes 0 through 40. It trained cleanly, evaluated at 2%, and went into my results table.

That run should have hit the same bug. It didn't, because episodes 0 through 40 are a contiguous block starting at zero, and for a block like that the absolute and the filtered indices are the same numbers. It passed by coincidence, not because the code was right.

This is the thing I keep coming back to. The crash was the good outcome. An out-of-bounds index is loud. The other case is an absolute index that happens to land inside the smaller table, which reads a frame from the wrong episode, with the wrong action attached, and reports nothing. In my crashed run, every sampled index below 12,727 had been doing exactly that until the first one above it came along. If the split had happened to leave the largest absolute index inside the filtered size, I'd have trained on garbage to completion and written up the number.

A run that passes for the wrong reason is worse than one that fails, because it produces a result you'll defend.

## The fix

I didn't want to fork the library for a training run, so I wrote a wrapper. It's about thirty lines. It imports the real training script, wraps the dataset factory to capture the absolute-to-relative dictionary the dataset already builds, and wraps the sampler's constructor to remap its indices through that dictionary. Then it calls the real main. Same command-line flags as the stock trainer, just a different entry point.

```python
_orig_sampler_init = EpisodeAwareSampler.__init__

def _patched_sampler_init(self, *args, **kwargs):
    _orig_sampler_init(self, *args, **kwargs)
    if _abs_to_rel:
        self.indices = [_abs_to_rel[i] for i in self.indices]

EpisodeAwareSampler.__init__ = _patched_sampler_init
```

The distribution-shift run went through on the second attempt and evaluated at 4%.

## Upstream

By the time I got around to filing this, someone else already had. [Issue #1895](https://github.com/huggingface/lerobot/issues/1895) on the LeRobot repo reports the same crash with the same cause, and the sampler gained an absolute-to-relative argument in version 0.6.0. The training script on main passes it. If you're on anything before 0.6.0 and you pass a non-contiguous episode list, you still need a workaround like the one above. If you're on a contiguous prefix, your run is fine, but not for a reason you can rely on.

"""Summarise a learning_curve.py run: gain G, per-rep means, and a 3-panel figure.

python3 bench/plot_learning_curve.py bench/results/argon-pilot docs/img/learning
"""

import csv
import os
import sys
from collections import defaultdict

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

SF, SL = "#2a78d6", "#eb6834"  # dataviz categorical slots 1 and 2
SURF, INK, INK2 = "#fcfcfb", "#0b0b0b", "#52514e"


def main(src, out):
    rows = list(csv.DictReader(open(os.path.join(src, "trials.csv"))))
    for r in rows:
        for k in ("rep", "r", "steps", "memory_steps", "calls"):
            r[k] = int(r[k])
        for k in ("cost", "seconds"):
            r[k] = float(r[k])
    by = {(r["cond"], r["rep"], r["task"]): r for r in rows}
    pairs = [(by[("sf", rep, t)], by[("sl", rep, t)]) for (c, rep, t) in by if c == "sf" and ("sl", rep, t) in by]
    G = sum(a["r"] - b["r"] for a, b in pairs)
    reps = sorted({r["rep"] for r in rows})
    agg = defaultdict(lambda: defaultdict(list))
    for r in rows:
        for k in ("r", "calls", "cost", "seconds", "steps", "memory_steps"):
            agg[(r["cond"], r["rep"])][k].append(r[k])

    def mean(c, rep, k):
        v = agg[(c, rep)][k]
        return sum(v) / len(v) if v else float("nan")

    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "data.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["cond", "rep", "n", "success", "calls", "cost", "seconds", "steps", "memory_steps"])
        for c in ("sf", "sl"):
            for rep in reps:
                w.writerow(
                    [c, rep, len(agg[(c, rep)]["r"])]
                    + [round(mean(c, rep, k), 4) for k in ("r", "calls", "cost", "seconds", "steps", "memory_steps")]
                )

    plt.rcParams.update({"font.size": 10, "text.color": INK, "axes.labelcolor": INK2})
    fig, axes = plt.subplots(1, 3, figsize=(10.5, 3.2), facecolor=SURF)
    panels = [("r", "Success rate"), ("calls", "Model calls per task"), ("cost", "Dollars per task")]
    for ax, (k, title) in zip(axes, panels, strict=True):
        ax.set_facecolor(SURF)
        for c, col, name in (("sf", SF, "Stateful (memory kept)"), ("sl", SL, "Stateless (fresh memory)")):
            ys = [mean(c, rep, k) for rep in reps]
            ax.plot(
                reps,
                ys,
                color=col,
                lw=2,
                marker="o",
                ms=12 if (k == "r" and c == "sf") else 8,
                mec=col if (k == "r" and c == "sf") else SURF,
                mew=2,
                label=name,
            )
            ax.annotate(
                ("%.3f" if k == "cost" else "%.2g") % ys[-1],
                (reps[-1], ys[-1]),
                xytext=(6, 0),
                textcoords="offset points",
                color=INK2,
                va="center",
                fontsize=9,
            )
        ax.set_title(title, loc="left", color=INK, fontsize=11)
        ax.set_xticks(reps)
        ax.set_xlabel("Repetition")
        ax.set_xlim(reps[0] - 0.3, reps[-1] + 0.6)
        if k == "r":
            ax.set_ylim(-0.05, 1.1)
            n = len(agg[("sf", reps[-1])]["r"])
            ax.text(
                reps[0],
                0.55,
                "Both conditions: every task solved\n(%d of %d per repetition)" % (n, n),
                color=INK2,
                fontsize=9,
            )
        else:
            ax.set_ylim(bottom=0)
        ax.grid(axis="y", color="#e6e5e1", lw=0.8)
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
        for s in ("left", "bottom"):
            ax.spines[s].set_color("#c9c8c3")
        ax.tick_params(colors=INK2)
    axes[0].legend(frameon=False, loc="lower left", fontsize=9)
    fig.tight_layout()
    for ext in ("png", "pdf"):
        fig.savefig(os.path.join(out, "learning_curve." + ext), dpi=200, facecolor=SURF)
    print("pairs=%d G=%d" % (len(pairs), G))
    for c in ("sf", "sl"):
        for rep in reps:
            print(
                c,
                rep,
                " ".join(
                    "%s=%.4g" % (k, mean(c, rep, k)) for k in ("r", "calls", "cost", "seconds", "steps", "memory_steps")
                ),
            )


if __name__ == "__main__":
    main(*sys.argv[1:3])

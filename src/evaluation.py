"""Standard-library off-policy evaluation for a restricted first-slot policy.

Each action must identify the *same complete display behavior* under logging and
target policies, e.g. the first review plus a fixed deterministic remainder rule.
These estimators do not identify per-review causality or a new whole-slate policy.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Mapping, Sequence


@dataclass(frozen=True)
class Episode:
    """One matured episode with a bounded reward and full action probabilities.

    Probability maps describe the restricted candidate set at assignment time.
    Target probabilities must come from a policy frozen before inspecting the
    held-out rewards. Probabilities are not scores or probabilities of reading.
    """

    episode_id: str
    user_id: str
    action: str
    reward: float
    behavior_probabilities: Mapping[str, float]
    target_probabilities: Mapping[str, float]
    mature: bool = True


@dataclass(frozen=True)
class Evaluation:
    episodes: int
    users: int
    ips: float
    snips: float | None
    ess: float
    sum_weights: float
    max_weight: float
    matched_episodes: int
    min_supported_probability: float
    ips_ci: tuple[float, float] | None
    snips_ci: tuple[float, float] | None
    confidence: float
    bootstrap_samples: int
    undefined_snips_bootstraps: int
    notes: tuple[str, ...]


def _probabilities(values: Mapping[str, float], label: str) -> None:
    if not values or any(not isinstance(key, str) or not key for key in values):
        raise ValueError(f"{label}: nonempty string action identifiers required")
    if any(not math.isfinite(p) or p < 0 or p > 1 for p in values.values()):
        raise ValueError(f"{label}: probabilities must be finite and in [0, 1]")
    if not math.isclose(math.fsum(values.values()), 1.0, abs_tol=1e-9):
        raise ValueError(f"{label}: probabilities must sum to 1")


def validate(episodes: Sequence[Episode]) -> None:
    """Fail closed on duplicate, immature, invalid or unsupported records."""
    if not episodes:
        raise ValueError("at least one matured episode is required")
    seen: set[str] = set()
    for row in episodes:
        if not isinstance(row.episode_id, str) or not row.episode_id:
            raise ValueError("nonempty episode_id required")
        if row.episode_id in seen:
            raise ValueError(f"duplicate episode_id: {row.episode_id}")
        seen.add(row.episode_id)
        if not isinstance(row.user_id, str) or not row.user_id:
            raise ValueError("nonempty user_id required for clustered inference")
        if row.mature is not True:
            raise ValueError(f"immature episode: {row.episode_id}")
        if not math.isfinite(row.reward) or not 0 <= row.reward <= 1:
            raise ValueError("reward must be finite and in [0, 1]")
        _probabilities(row.behavior_probabilities, "behavior")
        _probabilities(row.target_probabilities, "target")
        if set(row.behavior_probabilities) != set(row.target_probabilities):
            raise ValueError("behavior and target candidate sets must match")
        if row.action not in row.behavior_probabilities:
            raise ValueError("logged action is absent from candidate set")
        if row.behavior_probabilities[row.action] <= 0:
            raise ValueError("logged action must have positive behavior probability")
        for action, target_p in row.target_probabilities.items():
            if target_p > 0 and row.behavior_probabilities[action] <= 0:
                raise ValueError(f"target action lacks behavior support: {action}")
        weight = row.target_probabilities[row.action] / row.behavior_probabilities[row.action]
        if not math.isfinite(weight) or not math.isfinite(weight * weight):
            raise ValueError("importance weight exceeds numerical range")


def _statistics(pairs: Sequence[tuple[float, float]]) -> tuple[float, float | None, float, float]:
    sum_w = math.fsum(weight for weight, _ in pairs)
    sum_wr = math.fsum(weight * reward for weight, reward in pairs)
    sum_w2 = math.fsum(weight * weight for weight, _ in pairs)
    ips = sum_wr / len(pairs)
    snips = sum_wr / sum_w if sum_w else None
    ess = sum_w * (sum_w / sum_w2) if sum_w2 else 0.0
    return ips, snips, ess, sum_w


def _quantile(values: Sequence[float], p: float) -> float:
    ordered = sorted(values)
    index = p * (len(ordered) - 1)
    lo, hi = math.floor(index), math.ceil(index)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (index - lo)


def evaluate(
    episodes: Sequence[Episode], *, bootstrap_samples: int = 500,
    confidence: float = 0.95, seed: int = 20260910,
) -> Evaluation:
    """IPS/SNIPS with user-cluster percentile bootstrap intervals.

    Repeated episodes from one user are resampled together. Point estimates are
    episode-weighted; clusters may contain different numbers of episodes. There
    is no propensity estimation or clipping here. Low support must be diagnosed,
    not silently repaired. None denotes an interval/ratio that is unidentified.
    """
    validate(episodes)
    if not isinstance(bootstrap_samples, int) or bootstrap_samples < 0:
        raise ValueError("bootstrap_samples must be a nonnegative integer")
    if not math.isfinite(confidence) or not 0 < confidence < 1:
        raise ValueError("confidence must be between 0 and 1")
    clusters: dict[str, list[tuple[float, float]]] = defaultdict(list)
    pairs = []
    for row in episodes:
        weight = row.target_probabilities[row.action] / row.behavior_probabilities[row.action]
        pair = (weight, row.reward)
        pairs.append(pair)
        clusters[row.user_id].append(pair)
    ips, snips, ess, sum_w = _statistics(pairs)
    notes = ["Restricted first-slot action value; no individual review causal claim."]
    if ess < 30:
        notes.append("ESS below 30; estimate is unstable and cannot support a launch decision.")
    if snips is None:
        notes.append("No observed target-policy weight; SNIPS is undefined.")
    ips_ci = snips_ci = None
    undefined = 0
    actual_samples = 0
    if ess == 0:
        notes.append("Zero observed effective sample: algebraic IPS=0 is not evidence of zero value; intervals withheld.")
    elif len(clusters) < 2:
        notes.append("Fewer than two independent users; clustered intervals unavailable.")
    elif bootstrap_samples:
        rng = random.Random(seed)
        keys = sorted(clusters)
        ips_replicates: list[float] = []
        snips_replicates: list[float] = []
        for _ in range(bootstrap_samples):
            sample = [pair for key in rng.choices(keys, k=len(keys)) for pair in clusters[key]]
            rep_ips, rep_snips, _, _ = _statistics(sample)
            ips_replicates.append(rep_ips)
            if rep_snips is None:
                undefined += 1
            else:
                snips_replicates.append(rep_snips)
        actual_samples = bootstrap_samples
        alpha = (1 - confidence) / 2
        ips_ci = (_quantile(ips_replicates, alpha), _quantile(ips_replicates, 1 - alpha))
        # Dropping undefined ratios would condition the bootstrap on support.
        if not undefined:
            snips_ci = (_quantile(snips_replicates, alpha), _quantile(snips_replicates, 1 - alpha))
        else:
            notes.append("At least one bootstrap lacked target support; SNIPS interval withheld.")
    else:
        notes.append("Bootstrap disabled; no confidence intervals computed.")
    min_support = min(
        row.behavior_probabilities[action]
        for row in episodes for action, p in row.target_probabilities.items() if p > 0
    )
    return Evaluation(
        len(episodes), len(clusters), ips, snips, ess, sum_w,
        max(weight for weight, _ in pairs), sum(weight > 0 for weight, _ in pairs),
        min_support, ips_ci, snips_ci, confidence, actual_samples, undefined, tuple(notes),
    )


def synthetic_episodes(seed: int = 20260910, users: int = 1000, per_user: int = 5) -> list[Episode]:
    """Synthetic two-action logging experiment; explicitly not platform evidence."""
    if users < 1 or per_user < 1:
        raise ValueError("users and per_user must be positive")
    rng = random.Random(seed)
    rows = []
    for user in range(users):
        # Alternating types preserve planted average p(B)=0.55 for even users.
        user_effect = 0.08 if user % 2 else -0.08
        for episode in range(per_user):
            action = "A" if rng.random() < 0.9 else "B"
            probability = (0.25 if action == "A" else 0.55) + user_effect
            rows.append(Episode(
                f"synthetic-{user}-{episode}", f"user-{user}", action,
                float(rng.random() < probability), {"A": 0.9, "B": 0.1}, {"A": 0.0, "B": 1.0},
            ))
    return rows


def synthetic_report(seed: int = 20260910, bootstrap_samples: int = 500) -> str:
    rows = synthetic_episodes(seed)
    result = evaluate(rows, seed=seed, bootstrap_samples=bootstrap_samples)
    observed = math.fsum(row.reward for row in rows) / len(rows)
    serialized = json.dumps(asdict(result), ensure_ascii=False, indent=2)
    return f"""# 合成数据反事实评估：工程验证

此报告只验证概率日志、受限首位动作估计和不确定性计算，不证明真实平台转化提升，也不能归因某一条评论的购买效果。

## 可复现设置

- 随机种子：{seed}；用户数 1000；每用户 5 个成熟片段，共 {len(rows)} 个。每个片段仅一条结果记录。
- 行为策略：首位 A 概率 0.9，B 概率 0.1；目标策略：始终首位 B。其余界面行为由相同固定规则决定。
- 合成结果概率：A 为 0.25，B 为 0.55；用户交替叠加 +0.08 / -0.08，以形成用户内相关。
- 理论目标值 0.55、行为策略期望 0.28 均由生成器指定。后者不是同一 estimand。
- 按用户聚类 percentile bootstrap，{bootstrap_samples} 次，95% 区间。bootstrap 同一用户的所有片段一起抽样，点估计按片段加权。

## 结果

行为日志直接平均结果：{observed:.4f}。目标策略 IPS：{result.ips:.4f}；SNIPS：{result.snips:.4f}；ESS：{result.ess:.1f}。这些数值可用于核对加权计算是否接近预设生成机制；相差值不应宣传为真实业务提升。

```json
{serialized}
```

## 公式和边界

对片段 i，w_i = π_target(a_i|x_i) / π_behavior(a_i|x_i)。IPS = Σ(w_i r_i) / N；SNIPS = Σ(w_i r_i) / Σw_i；ESS = (Σw_i)² / Σ(w_i²)。代码不裁剪权重，不把模型分数冒充探索概率；SNIPS 有有限样本偏差。

必须满足：概率真实记录且策略选择可忽略混杂、目标动作在行为策略下均有正支持、相同动作对应相同完整展示行为、目标策略在独立评估结果前冻结、结果窗口已成熟、用户聚类可以近似独立。日志 schema 检查不能证明这些统计假设。生产环境须由服务端核验成熟窗口和 episode_id；浏览器传入 mature=true 不能作为证据。

该估计仅用于受限首位动作。改变整页队列、改变剩余评论规则、重新定义候选集、全新个性化策略或跨商品推荐，都不能直接套用此结论。若按用户随机化且一个动作跨会话持续生效，应改用用户作为 assignment unit 的设计和估计量。存在跨用户干扰、跨期 carryover 或商家适应行为时也需重新设计。

结果变量当前限制到 [0,1]。真实应用应同时对帮助性、购买、退款/退货、投诉等预先定义结果分别评估；付款结果必须来自平台服务端去重事件，而非仅靠客户端最后停留。低 ESS、极小概率或用户数少时，应继续安全采样，不能只凭区间通过发布。

## 运行

`python -m unittest discover -s tests -p test_evaluation.py -v`

`python -m src.evaluation --report docs/synthetic-evaluation.md`
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=20260910)
    parser.add_argument("--bootstrap-samples", type=int, default=500)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    report = synthetic_report(args.seed, args.bootstrap_samples)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report, encoding="utf-8")
        print(f"Synthetic engineering report written: {args.report}")
    else:
        print(report)


if __name__ == "__main__":
    main()

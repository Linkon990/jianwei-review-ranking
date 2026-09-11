"""Auditable prototype for ranking product reviews.

The module intentionally separates exposure measurement, weak attribution and
ranking. It is suitable for local replay/synthetic tests; it does not connect
to a commerce platform or accept client supplied payment labels.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Dict, Iterable, List, Optional, Sequence, Tuple


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass(frozen=True)
class Comment:
    comment_id: str
    text: str
    quality_prior: float = 0.5
    risk: float = 0.0
    topic: str = "general"
    sentiment: str = "neutral"
    created_order: int = 0
    eligible: bool = True


@dataclass(frozen=True)
class Exposure:
    episode_id: str
    session_id: str
    comment_id: str
    start_at: datetime
    end_at: datetime
    visible_fraction: float
    center_y: float
    foreground: bool = True
    page_visible: bool = True
    initial_screen: bool = False
    position_index: Optional[int] = None

    def duration_ms(self) -> int:
        return max(0, int((_utc(self.end_at) - _utc(self.start_at)).total_seconds() * 1000))


@dataclass
class Episode:
    episode_id: str
    user_key: str
    sku_id: str
    started_at: datetime
    purchased_at: Optional[datetime] = None
    refunded: Optional[bool] = None
    decision_help: Optional[float] = None
    mature_after_hours: float = 26.0

    def label(self, now: datetime) -> Optional[int]:
        """Return 1/0 after the primary window matures, else None (pending)."""
        now = _utc(now)
        start = _utc(self.started_at)
        if now < start + timedelta(hours=self.mature_after_hours):
            return None
        if self.purchased_at is None:
            return 0
        purchased = _utc(self.purchased_at)
        if not (start < purchased <= start + timedelta(hours=24)):
            return 0
        return 1

    def net_label(self, now: datetime) -> Optional[int]:
        """30-day net outcome has its own maturity, independent of gross pay."""
        gross = self.label(now)
        if gross != 1:
            return gross
        if _utc(now) < _utc(self.purchased_at) + timedelta(days=30, hours=2):
            return None
        if self.refunded is None:
            return None  # unknown callback completeness is not a success
        return 0 if self.refunded is True else 1


def position_weight(strategy: str, center_y: float, *, scrolling: bool = False) -> float:
    """Return a positive, normalized position weight in [0.125, 1].

    ``center_y`` is the full comment row's center normalized to the comment
    viewport, independent of outer-window clipping. Visibility is measured
    separately. The two functions from the plan are retained as baselines, but
    they are treated as experimental features rather than causal value.
    """
    y = min(1.0, max(0.0, center_y))
    if not isfinite(center_y):
        raise ValueError("non-finite position")
    if strategy == "uniform":
        return 1.0
    if strategy == "slide":
        # Approximation of the plan's row weights. Without a scroll event the
        # initial screen is deliberately uniform so it shares one scale.
        if not scrolling:
            return 1.0
        return min(8.0, max(1.0, 8 * y + .5)) / 8
    if strategy in {"center_lower", "middle"}:
        if not scrolling:
            return 1.0
        # Interpolate the eight original row-center weights exactly; no
        # assumption that a real device must display eight comments.
        values = [1, 3, 5, 7, 8, 8, 7, 5]
        z = min(7.0, max(0.0, y * 8 - 0.5))
        left = int(z)
        return (values[left] + (values[min(7, left + 1)] - values[left]) * (z - left)) / 8
    raise ValueError(f"unknown position strategy: {strategy}")


def valid_exposure(exposure: Exposure, *, min_visible: float = 0.5, min_duration_ms: int = 1000) -> bool:
    """Validate the minimum readable exposure proxy."""
    return (
        exposure.foreground
        and exposure.page_visible
        and 0.0 <= exposure.visible_fraction <= 1.0
        and 0.0 <= exposure.center_y <= 1.0
        and exposure.visible_fraction >= min_visible
        and exposure.duration_ms() >= min_duration_ms
        and exposure.duration_ms() <= 60000
    )


class ExposureLedger:
    """Union/accumulate exposure intervals per episode and comment."""

    def __init__(self, max_seconds: float = 30.0):
        self.max_ms = int(max_seconds * 1000)
        self._events: Dict[Tuple[str, str], List[Exposure]] = {}

    def add(self, exposure: Exposure) -> None:
        if valid_exposure(exposure):
            events = self._events.setdefault((exposure.episode_id, exposure.comment_id), [])
            if exposure not in events:
                events.append(exposure)

    def effective_seconds(self, episode_id: str, comment_id: str, strategy: str, *, start_at: Optional[datetime] = None, end_at: Optional[datetime] = None) -> float:
        events = sorted(self._events.get((episode_id, comment_id), []), key=lambda e: _utc(e.start_at))
        if start_at is not None or end_at is not None:
            clipped = []
            for e in events:
                a = max(_utc(e.start_at), _utc(start_at)) if start_at is not None else _utc(e.start_at)
                b = min(_utc(e.end_at), _utc(end_at)) if end_at is not None else _utc(e.end_at)
                candidate = replace(e, start_at=a, end_at=b)
                if valid_exposure(candidate):
                    clipped.append(candidate)
            events = clipped
        if not events:
            return 0.0
        # Deterministic segment union: overlapping intervals contribute once,
        # using the maximum observed weight. Input order cannot change totals.
        points = sorted({_utc(e.start_at) for e in events} | {_utc(e.end_at) for e in events})
        total, elapsed = 0.0, 0.0
        for a, b in zip(points, points[1:]):
            active = [e for e in events if _utc(e.start_at) <= a and _utc(e.end_at) >= b]
            if not active:
                continue
            seconds = min((b - a).total_seconds(), self.max_ms / 1000 - elapsed)
            total += seconds * max(e.visible_fraction * position_weight(strategy, e.center_y, scrolling=not e.initial_screen) for e in active)
            elapsed += seconds
            if elapsed >= self.max_ms / 1000:
                break
        return total

    def contribution_vector(self, episode: Episode, strategy: str, now: datetime) -> Dict[str, float]:
        label = episode.label(now)
        if label is None:
            return {}
        start = _utc(episode.started_at)
        end = min(start + timedelta(hours=24), _utc(now))
        if episode.purchased_at is not None and start < _utc(episode.purchased_at) <= end:
            end = _utc(episode.purchased_at)
        values = {cid: self.effective_seconds(episode.episode_id, cid, strategy, start_at=start, end_at=end) for (eid, cid) in self._events if eid == episode.episode_id}
        denom = sum(values.values())
        if denom <= 0:
            return {}
        return {cid: value / denom for cid, value in values.items() if value > 0}


@dataclass
class CommentStats:
    positive: float = 0.0
    negative: float = 0.0
    prior: float = 0.5

    def score(self) -> float:
        # Prior smoothing prevents a single order from permanently pinning
        # a new comment at the top and makes non-purchase evidence usable.
        return (self.prior + self.positive) / (1.0 + self.positive + self.negative)


class CommentRanker:
    """Constrained ranker with bounded first-slot exploration."""

    def __init__(self, comments: Sequence[Comment], *, epsilon: float = 0.10, strategy: str = "uniform"):
        self.comments = {c.comment_id: c for c in comments}
        self.epsilon = max(0.0, min(1.0, epsilon))
        self.strategy = strategy
        self.stats = {c.comment_id: CommentStats(prior=max(0.0, min(1.0, c.quality_prior))) for c in comments}
        self._updates = {}

    def update(self, episode: Episode, ledger: ExposureLedger, now: datetime) -> None:
        # Weak net-purchase association is deliberately separate from gross
        # purchase reporting. In the demo the outcome control advances time.
        label = episode.net_label(now)
        if label is None:
            raise ValueError("episode label is pending; do not update ranking")
        vector = ledger.contribution_vector(episode, self.strategy, now)
        if any(cid not in self.comments for cid in vector):
            raise ValueError("unknown comment")
        old = self._updates.get(episode.episode_id)
        if old is not None:
            old_label, old_vector = old
            for cid, share in old_vector.items():
                if old_label == 1:
                    self.stats[cid].positive -= share
                else:
                    self.stats[cid].negative -= share
        for cid, share in vector.items():
            stat = self.stats[cid]
            if label == 1:
                stat.positive += share
            else:
                stat.negative += share
        self._updates[episode.episode_id] = (label, vector)

    def scores(self) -> Dict[str, float]:
        # Conservative default: behavior is limited to 30% of rank score.
        # Both coefficients are engineering defaults, to be calibrated.
        return {cid: .7 * c.quality_prior + .3 * self.stats[cid].score() for cid, c in self.comments.items()}

    def rank(self, candidate_ids: Optional[Iterable[str]] = None, *, baseline_order: Optional[Sequence[str]] = None, explore: bool = False, seed: Optional[int] = None) -> Tuple[List[str], Dict[str, object]]:
        import random
        ids = list(dict.fromkeys(cid for cid in (self.comments if candidate_ids is None else candidate_ids) if cid in self.comments and self.comments[cid].eligible))
        if not ids:
            return [], {}
        base = list(baseline_order) if baseline_order is not None else sorted(ids, key=lambda cid: (-self.scores()[cid], cid))
        base = list(dict.fromkeys(base))
        base = [cid for cid in base if cid in ids] + [cid for cid in ids if cid not in base]
        # Preserve a credible limitation in the first three whenever supplied.
        # This transform occurs BEFORE randomization, so probabilities remain
        # valid for the fixed baseline and deterministic completion below.
        risk_ids = [cid for cid in base if self.comments[cid].risk >= .5]
        if risk_ids and len(base) > 1:
            risk_id = risk_ids[0]
            base.remove(risk_id)
            base.insert(1, risk_id)
        base_first = base[0]
        rng = random.Random(seed) if seed is not None else random.SystemRandom()
        eps = self.epsilon if explore else 0.0
        probs = {cid: eps / len(ids) for cid in ids}
        probs[base_first] += 1.0 - eps
        chosen = base_first
        if len(ids) > 1 and rng.random() < eps:
            chosen = rng.choice(ids)
        rest = [cid for cid in base if cid != chosen]
        return [chosen] + rest, {"action": chosen, "logging_probability": probs[chosen], "epsilon": eps, "baseline_order": base, "candidate_ids": ids, "probabilities": probs, "policy_version": "prototype-0.1.0"}


def make_synthetic_episode(episode_id: str = "ep-1") -> Tuple[Episode, List[Exposure]]:
    """Small deterministic fixture for demos and smoke tests."""
    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    ep = Episode(episode_id, "user-1", "sku-1", t0, purchased_at=t0 + timedelta(hours=2), refunded=False)
    events = [Exposure(episode_id, "s-1", f"c{i}", t0 + timedelta(minutes=i), t0 + timedelta(minutes=i, seconds=2), 0.9, 0.45 + 0.05 * (i % 3), initial_screen=(i < 2)) for i in range(1, 5)]
    return ep, events

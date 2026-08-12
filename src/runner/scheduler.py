"""AFL-style energy scheduler for the fuzzing corpus."""

from __future__ import annotations

import random
from collections.abc import Sequence
from dataclasses import dataclass

from .corpus_manager import Seed


@dataclass
class SchedulerConfig:
    """Configuration for energy assignment."""

    base_energy: int = 10
    crash_bonus: int = 100
    coverage_bonus: int = 50
    depth_bonus: int = 5
    rng: random.Random | None = None

    def __post_init__(self) -> None:
        """Reject malformed energy settings before they affect scheduling."""
        for name in ("base_energy", "crash_bonus", "coverage_bonus", "depth_bonus"):
            value = getattr(self, name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")


class Scheduler:
    """Select seeds with probability proportional to their energy."""

    def __init__(self, config: SchedulerConfig | None = None) -> None:
        self.config = config if config is not None else SchedulerConfig()
        self.rng = self.config.rng or random.Random()

    def assign_energy(self, seed: Seed, depth: int = 0) -> int:
        """Compute energy for a seed based on metadata."""
        if depth < 0:
            raise ValueError("depth must be non-negative")

        energy = self.config.base_energy

        if seed.crash_class not in {"NONE", "UNKNOWN", "TIMEOUT"}:
            energy += self.config.crash_bonus

        if seed.coverage_hash:
            energy += self.config.coverage_bonus

        energy += depth * self.config.depth_bonus
        # A stored energy is the last durable scheduling weight. Treat it as a
        # floor so reloading a corpus preserves learned preference while new
        # metadata bonuses can still raise the current weight.
        return max(1, seed.energy, energy)

    def select(self, seeds: Sequence[Seed]) -> Seed:
        """Select a seed weighted by energy."""
        if not seeds:
            raise ValueError("Cannot select from empty seed list")

        energies = [self.assign_energy(seed) for seed in seeds]
        total = sum(energies)
        point = self.rng.uniform(0, total)
        cumulative = 0.0
        for seed, energy in zip(seeds, energies):
            cumulative += energy
            if point <= cumulative:
                return seed
        return seeds[-1]

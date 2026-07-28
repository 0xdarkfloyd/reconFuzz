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


class Scheduler:
    """Select seeds with probability proportional to their energy."""

    def __init__(self, config: SchedulerConfig | None = None) -> None:
        self.config = config or SchedulerConfig()

    def assign_energy(self, seed: Seed, depth: int = 0) -> int:
        """Compute energy for a seed based on metadata."""
        energy = self.config.base_energy

        if seed.crash_class != "NONE" and seed.crash_class != "unknown":
            energy += self.config.crash_bonus

        if seed.coverage_hash:
            energy += self.config.coverage_bonus

        energy += depth * self.config.depth_bonus
        return max(1, energy)

    def select(self, seeds: Sequence[Seed]) -> Seed:
        """Select a seed weighted by energy."""
        if not seeds:
            raise ValueError("Cannot select from empty seed list")

        energies = [self.assign_energy(seed) for seed in seeds]
        total = sum(energies)
        point = random.uniform(0, total)
        cumulative = 0.0
        for seed, energy in zip(seeds, energies):
            cumulative += energy
            if point <= cumulative:
                return seed
        return seeds[-1]

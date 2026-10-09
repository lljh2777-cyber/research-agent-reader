"""Small read-only fixture for interactive code reading. Never run by the tests."""
from helpers import mean_positive


def summarize(values):
    result = mean_positive(values)
    return {"positive_mean": result, "input_count": len(values)}


if __name__ == "__main__":
    print(summarize([-2, 0, 2, 4]))

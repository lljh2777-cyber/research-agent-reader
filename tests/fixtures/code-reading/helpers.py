def mean_positive(values):
    positive = [value for value in values if value > 0]
    if not positive:
        return None
    return sum(positive) / len(positive)

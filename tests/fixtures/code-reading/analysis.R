# Static reading fixture, not an executed experiment.
mean_positive <- function(values) {
  positive <- values[values > 0]
  if (length(positive) == 0) return(NA_real_)
  mean(positive)
}

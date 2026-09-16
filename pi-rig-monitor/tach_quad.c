// tach_quad.c - x1 pulse counter for the Taiss E38S6-600-24G encoder.
//
// Companion to rig_monitor.py: Python-per-edge callbacks (lgpio) saturate the
// interpreter above ~11 mph, and even C event handling hits a wall -- each
// GPIO edge is one kernel interrupt + event-queue entry, and the x4 decode
// (both edges of A and B) costs ~20 us of system time per edge on the
// Zero 2 W. Measured 2026-08-17: 44% CPU at an indicated 5 mph (~22.6k
// edges/s), saturating at ~51k edges/s = an indicated ~11 mph, exactly the
// ceiling-plus-noise the 2026-08-12 full-matrix run showed above 10 mph.
//
// Fix: count x1 -- request ONLY line A, RISING edges only. The kernel then
// never raises the other 3/4 of the interrupts (hardware edge select), so
// 14 mph is ~16k events/s (~31% CPU) instead of ~64k (impossible). The
// encoder gives 600 rising edges of A per rev, so resolution is unchanged
// for the 10 Hz consumer (~0.02 mph per count).
//
// x1 cannot sense direction; this rig's belt only runs forward, and the
// Python side always used the magnitude for mph. count is monotonically
// increasing. The third CLI arg (invert) is accepted for command-line
// compatibility and ignored.
//
//   usage: tach_quad [gpio_a] [gpio_b] [invert]      (defaults: 17 27 1)
//   build: gcc -O2 -Wall -o tach_quad tach_quad.c $(pkg-config --cflags --libs libgpiod)
//
// Output line: "<CLOCK_MONOTONIC ns> <x1 pulse count>\n"
// (same clock as Python's time.monotonic_ns(); NOTE count is x1 pulses,
// NOT the old x4 quadrature steps -- rig_monitor.py's math must not /4.)

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <signal.h>
#include <time.h>
#include <gpiod.h>

#define GPIO_CHIP "/dev/gpiochip0"
#define OUTPUT_INTERVAL_NS 20000000LL   // 50 Hz
#define WAIT_TIMEOUT_NS    20000000LL
#define EVENT_BUF_CAP      512          // events drained per read
#define KERNEL_QUEUE_SIZE  4096         // kernel-side event backlog headroom

static volatile sig_atomic_t running = 1;
static void on_signal(int sig) { (void)sig; running = 0; }

static int64_t now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

int main(int argc, char *argv[]) {
    unsigned int gpio_a = argc > 1 ? (unsigned int)atoi(argv[1]) : 17;
    // argv[2] (gpio_b) and argv[3] (invert) are accepted but unused by the
    // x1 decode; B stays unrequested so the kernel never IRQs on it.
    (void)argc; (void)argv;

    struct gpiod_chip *chip = gpiod_chip_open(GPIO_CHIP);
    if (!chip) { fprintf(stderr, "tach_quad: cannot open %s\n", GPIO_CHIP); return 1; }

    struct gpiod_line_settings *settings = gpiod_line_settings_new();
    struct gpiod_line_config *line_cfg = gpiod_line_config_new();
    struct gpiod_request_config *req_cfg = gpiod_request_config_new();
    if (!settings || !line_cfg || !req_cfg) { fprintf(stderr, "tach_quad: alloc failed\n"); return 1; }

    gpiod_line_settings_set_direction(settings, GPIOD_LINE_DIRECTION_INPUT);
    gpiod_line_settings_set_edge_detection(settings, GPIOD_LINE_EDGE_RISING);
    gpiod_line_settings_set_bias(settings, GPIOD_LINE_BIAS_PULL_UP);

    unsigned int offsets[1] = { gpio_a };
    if (gpiod_line_config_add_line_settings(line_cfg, offsets, 1, settings)) {
        fprintf(stderr, "tach_quad: line config failed\n"); return 1;
    }
    gpiod_request_config_set_consumer(req_cfg, "tach-quad");
    gpiod_request_config_set_event_buffer_size(req_cfg, KERNEL_QUEUE_SIZE);

    struct gpiod_line_request *req = gpiod_chip_request_lines(chip, req_cfg, line_cfg);
    if (!req) { fprintf(stderr, "tach_quad: request line %u failed (already claimed?)\n", gpio_a); return 1; }

    struct gpiod_edge_event_buffer *evbuf = gpiod_edge_event_buffer_new(EVENT_BUF_CAP);
    if (!evbuf) { fprintf(stderr, "tach_quad: event buffer alloc failed\n"); return 1; }

    int64_t count = 0;

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    fprintf(stderr, "tach_quad: A=%u x1 rising-edge count, 50 Hz samples on stdout\n",
            gpio_a);

    int64_t next_out = now_ns() + OUTPUT_INTERVAL_NS;
    while (running) {
        int ret = gpiod_line_request_wait_edge_events(req, WAIT_TIMEOUT_NS);
        if (ret < 0) { fprintf(stderr, "tach_quad: wait failed\n"); break; }
        if (ret > 0) {
            int n = gpiod_line_request_read_edge_events(req, evbuf, EVENT_BUF_CAP);
            if (n < 0) { fprintf(stderr, "tach_quad: read failed\n"); break; }
            count += n;   // every event is a rising edge of A: one pulse
        }
        int64_t t = now_ns();
        if (t >= next_out) {
            printf("%lld %lld\n", (long long)t, (long long)count);
            fflush(stdout);
            next_out = t + OUTPUT_INTERVAL_NS;
        }
    }

    gpiod_edge_event_buffer_free(evbuf);
    gpiod_line_request_release(req);
    gpiod_request_config_free(req_cfg);
    gpiod_line_config_free(line_cfg);
    gpiod_line_settings_free(settings);
    gpiod_chip_close(chip);
    return 0;
}

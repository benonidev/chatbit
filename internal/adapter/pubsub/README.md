# Go Pub/Sub Library — Integration Guide

This document explains how to add and use the Pub/Sub library in another Go project. It also describes the four variants you can choose from:
- Basic PubSub (no cache, no topics)
- PubSub with Cache
- Topic-based PubSub (no cache)
- Topic-based PubSub with Cache

## Requirements
- Go 1.26+
- Modules enabled (Go modules)

## Installation

Add module to your `go.mod` and run `go mod tidy`:

## High-level Concepts

- Publisher: Sends messages to Subscriber.
- Subscriber: Receives messages through callbacks.
- Message: Arbitrary payload you define.
- Topic (topic variants only): publisher sends Topic Message only to subscribers subscribed to the same Topic.
- Cache (cache variants only): Stores last TTL-scoped messages so that late subscribers can receive recent messages immediately on subscription.

## Choosing a Variant

- Basic PubSub:
  - Use when you just need broadcast semantics without topics or history.
- PubSub with Cache:
  - Use when late subscribers should immediately receive recent messages (e.g., latest state).
- Topic-based PubSub:
  - Use when you need logical separation of messages by name (e.g., “orders”, “metrics”).
- Topic-based PubSub with Cache:
  - Use when you need both topic separation and immediate replay of recent messages per topic.

## Quick Start

### 1) Basic PubSub (no cache, no topics)
```go
func main() {
    ps := pubsub.NewAdapter() // create basic PubSub
    defer ps.Close()

    // Subscribe
    unsub, _ := ps.Subscribe(func(msg interface{}) {
        fmt.Println("received:", msg)
    })
    defer ps.Unsubscribe(unsub)

    // Publish
    ps.Publish("hello world")

    // Give time for async delivery
    time.Sleep(50 * time.Millisecond)

    // Graceful shutdown
    _ = ps.Close()
    <-time.After(10 * time.Millisecond)
}
```

output:
```text
received: hello world
```

### 2) PubSub with Cache
```go
func main() {
    // Example: cache retains last messages for a TTL (10s)
    ps := pubsub.NewAdapterCache( time.Second * 10 )
    defer ps.Close()

    // Publish a few messages before any subscriber joins
    ps.Publish("A")
    ps.Publish("B")

	// wait some time to make sure messages are cached
	time.Sleep(500 * time.Millisecond)

    // New subscriber should immediately receive cached messages (A, B)
    unsub, _ := ps.Subscribe(func(msg interface{}) {
        fmt.Println("received:", msg)
    })
	defer ps.Unsubscribe(unsub)

    ps.Publish("C") // live messages continue as normal

    time.Sleep(50 * time.Millisecond)
}
```

output:
```text
received: A
received: B
received: C
```

### 3) Topic-based PubSub (no cache)
```go
func main() {
    tps := pubsub.NewAdapterTopic() // topic-aware PubSub
    defer tps.Close()

    // Subscribe to topic "orders"
    unsubOrders, _ := tps.Subscribe("orders", func(msg interface{}) {
        fmt.Println("orders:", msg)
    })
	defer tps.Unsubscribe("orders", unsubOrders)

    // Subscribe to topic "metrics"
    unsubMetrics, _ := tps.Subscribe("metrics", func(msg interface{}) {
        fmt.Println("metrics:", msg)
    })
	defer tps.Unsubscribe("metrics", unsubMetrics)

    // Publish to specific topics
    tps.Publish("orders", "order#123 created")
    tps.Publish("metrics", "cpu: 0.71")

    time.Sleep(50 * time.Millisecond)
}
```

output:
```text
orders: order#123 created
metrics: cpu: 0.71
```

### 4) Topic-based PubSub with Cache
```go
func main() {
    tps := pubsub.NewAdapterTopicCache(time.Second * 10)
    defer tps.Close()

    // Publish on a topic before any subscribers
    tps.Publish("alerts", "service degraded")

    // Late subscriber will receive recent cached messages for "alerts"
    unsub, _ := tps.Subscribe("alerts", func(msg interface{}) {
        fmt.Println("alerts:", msg)
    })
	defer tps.Unsubscribe("alerts", unsub)

    tps.Publish("alerts", "service recovered")

    time.Sleep(50 * time.Millisecond)
}
```

output:
```text
alerts: service degraded
alerts: service recovered
```

## API Overview

- Constructors:
  - Basic: `NewAdapter()`
  - With Cache: `NewAdapterCache(ttl time.Duration)`
  - With Topics: `NewAdapterTopics()`
  - With Topics + Cache: `NewAdapterTopicCache(ttl time.Duration)`

- Publish:
  - Basic/Cache: `Publish(msg interface{})`
  - Topics: `Publish(topic string, msg interface{})`

- Subscribe:
  - Basic/Cache: `Subscribe(handler func(interface{})) (subID string)`
  - Topics: `Subscribe(topic string, handler func(interface{})) (subID string)`

- Unsubscribe:
    - Basic/Cache: `Unsubscribe(subID string)`
    - Topics: `Unsubscribe(topic, subID string) `

- Close:
  - All variants: `Close()` (stops dispatchers, prevents new publications, and releases resources)

    

## Troubleshooting

- No messages received:
  - Ensure you subscribed before publishing (unless using cache variants).
  - Confirm your handler isn’t panicking.
  - Make sure the program doesn’t exit before async delivery; add a short wait in examples.

- Late subscribers miss history:
  - Use a cache variant and configure TTL appropriately.

- Topic subscribers don’t receive messages:
  - Verify you’re publishing to the correct topic string.
  - Ensure you subscribed to the same exact topic key.


package pubsub

import (
	"errors"
	"fmt"
	"sync"
)

// AdapterTopic represents a topic-based pub-sub system, managing multiple topics and their respective subscribers.
// It ensures thread safety and provides mechanisms for publishing, subscribing, and unsubscribing from topics.
// BufferSize specifies the buffer size for each topic's subscribers.
// MaxSubscribers limits the total number of subscribers across all topics.
// The `closed` field tracks if the AdapterTopic is operational or has been closed.
type AdapterTopic[U Identifier, T any] struct {
	mu             sync.RWMutex
	subs           map[U]*Adapter[U, T]
	BufferSize     int
	MaxSubscribers int
	closed         bool
}

// NewAdapterTopic creates and initializes a new instance of AdapterTopic with default buffer size and maximum subscribers.
func NewAdapterTopic[U Identifier, T any]() *AdapterTopic[U, T] {
	at := &AdapterTopic[U, T]{}
	at.subs = make(map[U]*Adapter[U, T])
	at.BufferSize = bufferSize
	at.MaxSubscribers = maxSubscribers

	return at
}

// Publish sends the given object to all subscribers of the specified topic, or does nothing if there are no subscribers.
func (at *AdapterTopic[U, T]) Publish(topic U, obj T) error {
	at.mu.Lock()
	defer at.mu.Unlock()

	if at.closed {
		return ErrAlreadyClosed
	}

	subs, ok := at.subs[topic]
	if ok {
		return subs.Publish(obj)
	}

	// if there has no subscriber for this topic do nothing
	return nil
}

// PublishExclude
func (at *AdapterTopic[U, T]) PublishExclude(topic, subID U, obj T) error {
	at.mu.Lock()
	defer at.mu.Unlock()

	if at.closed {
		return ErrAlreadyClosed
	}

	subs, ok := at.subs[topic]
	if ok {
		return subs.PublishExclude(subID, obj)
	}

	// if there has no subscriber for this topic do nothing
	return nil
}

// PublishTo sends an object to a specific subscriber of a topic using the subscriber's unique ID.
// Returns an error if the topic or subscriber ID is not found.
// No operation is performed if the topic has no subscribers.
func (at *AdapterTopic[U, T]) PublishTo(topic, subID U, obj T) error {
	at.mu.Lock()
	defer at.mu.Unlock()

	subs, ok := at.subs[topic]
	if ok {
		return subs.PublishTo(subID, obj)
	}

	// if there has no subscriber for this topic do nothing
	return nil
}

// SubscribeWithID registers a callback to the specified topic, returning a unique subscription ID or an error if the operation fails.
func (at *AdapterTopic[U, T]) SubscribeWithID(subID, topic U, update func(obj T)) (U, error) {
	at.mu.Lock()
	defer at.mu.Unlock()

	var output U

	if at.closed {
		return output, ErrAlreadyClosed
	}

	// MaxSubscribers is a limit per topic (checked by the topic adapter), not for all topics
	// together — a global limit would let a few connections block the whole server.
	subs, ok := at.subs[topic]
	if !ok {
		subs = at.newTopicAdapter()

		at.subs[topic] = subs
	}

	return subs.SubscribeWithID(subID, update)
}

// Subscribe registers a callback to the specified topic, returning a unique subscription ID or an error if the operation fails.
func (at *AdapterTopic[U, T]) Subscribe(topic U, update func(obj T)) (U, error) {
	at.mu.Lock()
	defer at.mu.Unlock()

	var output U

	if at.closed {
		return output, ErrAlreadyClosed
	}

	// MaxSubscribers is a limit per topic (checked by the topic adapter), not for all topics
	// together — a global limit would let a few connections block the whole server.
	subs, ok := at.subs[topic]
	if !ok {
		subs = at.newTopicAdapter()

		at.subs[topic] = subs
	}

	return subs.Subscribe(update)
}

// AddSubscriberToTopic registers an existing subscriber to a new topic
func (at *AdapterTopic[U, T]) AddSubscriberToTopic(topic, subID U) error {
	at.mu.Lock()
	defer at.mu.Unlock()

	if at.closed {
		return ErrAlreadyClosed
	}

	subT, err := at.getSubscriber(subID)
	if err != nil {
		return fmt.Errorf("not possible to get subscriber %s: %w", subID, ErrSubscriberMissing)
	}

	subs, ok := at.subs[topic]
	if !ok {
		subs = at.newTopicAdapter()

		at.subs[topic] = subs
	}

	err = subs.AddSubscriber(subID, subT)
	if err != nil {
		return fmt.Errorf("not possible to add subscriber %s to topic %s: %w", subID, topic, err)
	}

	return nil
}

func (at *AdapterTopic[U, T]) getSubscriber(subID U) (chan T, error) {
	for _, sub := range at.subs {
		subsT, err := sub.GetSubscriber(subID)
		if err != nil {
			continue
		}

		return subsT, nil
	}

	return nil, fmt.Errorf("subscriber %s not found: %w", subID, ErrSubscriberMissing)
}

// UnsubscribeFromTopic removes a subscriber from a topic using its ID, cleans up if no subscribers remain, and handles errors.
func (at *AdapterTopic[U, T]) UnsubscribeFromTopic(topic, subID U) error {
	at.mu.Lock()
	defer at.mu.Unlock()

	if at.closed {
		return ErrAlreadyClosed
	}

	var err error

	var subsT chan T

	subs, ok := at.subs[topic]
	if !ok {
		return ErrTopicMissing
	}

	subsT, err = subs.GetSubscriber(subID)
	if err != nil {
		return err
	}

	err = subs.UnsubscribeNoClose(subID)
	if err != nil {
		return err
	}

	if len(subs.subs) == 0 {
		err = subs.Close()
		if err != nil {
			return err
		}

		delete(at.subs, topic)
	}

	_, err = at.getSubscriber(subID)
	if errors.Is(err, ErrSubscriberMissing) {
		close(subsT)
	}

	return nil
}

// Unsubscribe removes a subscriber from a topic using its ID, cleans up if no subscribers remain, and handles errors.
func (at *AdapterTopic[U, T]) Unsubscribe(subID U) error {
	at.mu.Lock()
	defer at.mu.Unlock()

	if at.closed {
		return ErrAlreadyClosed
	}

	subsT, err := at.getSubscriber(subID)
	if errors.Is(err, ErrSubscriberMissing) {
		return nil
	}

	for topic := range at.subs {
		subs, ok := at.subs[topic]
		if ok {
			err = subs.UnsubscribeNoClose(subID)
			if err != nil {
				return err
			}
		}

		if len(subs.subs) == 0 {
			err = subs.Close()
			if err != nil {
				return err
			}

			delete(at.subs, topic)
		}
	}

	close(subsT)

	return nil
}

// Close releases all resources by closing all topic adapters and marking the AdapterTopic as closed. Returns an error if already closed.
func (at *AdapterTopic[U, T]) Close() error {
	at.mu.Lock()
	defer at.mu.Unlock()

	if at.closed {
		return ErrAlreadyClosed
	}

	for topic, subs := range at.subs {
		_ = subs.Close()

		delete(at.subs, topic)
	}

	at.closed = true

	return nil
}

// Open reinitializes the AdapterTopic by unlocking it if it is currently closed; returns an error if already open.
func (at *AdapterTopic[U, T]) Open() error {
	at.mu.Lock()
	defer at.mu.Unlock()

	if !at.closed {
		return ErrAlreadyOpen
	}

	at.closed = false

	return nil
}

// newTopicAdapter creates a new Adapter instance with buffer size and maximum subscribers inherited from the AdapterTopic.
func (at *AdapterTopic[U, T]) newTopicAdapter() *Adapter[U, T] {
	a := NewAdapter[U, T]()
	a.BufferSize = at.BufferSize
	a.MaxSubscribers = at.MaxSubscribers
	return a
}

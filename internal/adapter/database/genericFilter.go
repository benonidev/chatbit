package database

import (
	"encoding/json"
	"fmt"

	"github.com/dgraph-io/badger/v4"
)

func (a *AdapterTs[T]) GetObjectsByPrefixAndSinceTs(prefix []byte, timestamp uint64) ([]T, error) {
	var objects []T

	err := a.db.View(func(txn *badger.Txn) error {
		itr := txn.NewIterator(badger.IteratorOptions{
			Prefix: prefix,
			//		SinceTs: timestamp,
		})

		defer itr.Close()

		for itr.Rewind(); itr.Valid(); itr.Next() {
			item := itr.Item()

			//Important to copy
			objCopyBin, err := item.ValueCopy(nil)
			if err != nil {
				return err
			}

			var obj T

			err = json.Unmarshal(objCopyBin, &obj)
			if err != nil {
				return fmt.Errorf("failed to unmarshal object: %w", err)
			}

			if obj.GetTimestamp() <= timestamp {
				continue
			}

			objects = append(objects, obj)
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	return objects, nil
}

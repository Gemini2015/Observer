//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows/registry"
)

const (
	autostartKey  = `Software\Microsoft\Windows\CurrentVersion\Run`
	autostartName = "ObserverAgent"
)

func autostartEnabled() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, autostartKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	_, _, err = key.GetStringValue(autostartName)
	return err == nil
}

func setAutostart(enabled bool, configPath string) error {
	if !enabled {
		key, err := registry.OpenKey(registry.CURRENT_USER, autostartKey, registry.SET_VALUE)
		if err != nil {
			return err
		}
		defer key.Close()
		if err := key.DeleteValue(autostartName); err != nil && err != registry.ErrNotExist {
			return err
		}
		return nil
	}

	key, _, err := registry.CreateKey(registry.CURRENT_USER, autostartKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	command := `"` + executable + `" -config "` + configPath + `"`
	return key.SetStringValue(autostartName, command)
}

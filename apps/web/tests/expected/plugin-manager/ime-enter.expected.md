Synthetic browser KeyboardEvents, not an OS input-method test.
package / isComposing=true: inspect=0, install=0; editable; value retained
- textbox "Package name or address":
  - /placeholder: for example dsh-plugin-whale-pet
  - text: ime-confirm-package
package / Safari isComposing=false, keyCode=229: inspect=0, install=0; editable; value retained
- textbox "Package name or address":
  - /placeholder: for example dsh-plugin-whale-pet
  - text: ime-confirm-package
package / compositionstart + unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "Package name or address":
  - /placeholder: for example dsh-plugin-whale-pet
  - text: ime-confirm-package
package / compositionend + immediate unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "Package name or address":
  - /placeholder: for example dsh-plugin-whale-pet
  - text: ime-confirm-package
package / compositionend + 9ms unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "Package name or address":
  - /placeholder: for example dsh-plugin-whale-pet
  - text: ime-confirm-package
package / plain Enter: inspect=1, install=1
- dialog "The plugin could not be installed":
  - button "Back to editing": Edit
  - button "Close"
  - alert: The plugin could not be installed
  - paragraph: "IME fixture: no package was installed"
  - paragraph: ime-confirm-package
  - paragraph: Version 1.0.0
  - button "Show install details"
  - button "Retry"
custom registry / isComposing=true: inspect=0, install=0; editable; value retained
- textbox "Custom address":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / Safari isComposing=false, keyCode=229: inspect=0, install=0; editable; value retained
- textbox "Custom address":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / compositionstart + unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "Custom address":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / compositionend + immediate unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "Custom address":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / compositionend + 9ms unmarked Enter: inspect=0, install=0; editable; value retained
- textbox "Custom address":
  - /placeholder: https://npm.example.com/
  - text: https://registry.example.test/
custom registry / plain Enter: inspect=1, install=1
- dialog "The plugin could not be installed":
  - button "Back to editing": Edit
  - button "Close"
  - alert: The plugin could not be installed
  - paragraph: "IME fixture: no package was installed"
  - paragraph: ime-confirm-registry
  - paragraph: Version 1.0.0
  - button "Show install details"
  - button "Retry"
Profile manifest unchanged; controlled Host result performed no package installation.
